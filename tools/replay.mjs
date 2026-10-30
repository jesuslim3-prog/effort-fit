// Replays the judge in hooks/judge.ts over Claude Code transcripts, read-only,
// to see what the panel would have shown on real work before changing a rule.
//
//   node --no-warnings tools/replay.mjs <out.json> <transcript dir>...
//   e.g. node --no-warnings tools/replay.mjs tools/rows.json ~/.claude/projects/C--Desktop-my-project
//
// Set JUDGE=<path to a judge module> to replay a changed copy of the rules.
// Needs Node 23.6 or later (it imports the .ts file directly).
//
// Tool results go through the same fromTranscript → recordTool → readLevel →
// judge path the live plugin's fromToolCall → recordTool → … takes. What a
// transcript does not carry is marked, not invented: read-only is a guess
// (readOnlyBasis "estimate:strict", Bash never read-only, or "estimate:heur",
// by its first word); the judge itself no longer reads it.
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

const J = await import(process.env.JUDGE ? pathToFileURL(path.resolve(process.env.JUDGE)).href : new URL('../hooks/judge.ts', import.meta.url).href)

const [outPath, ...dirs] = process.argv.slice(2)
const FAILURE_WINDOW = 3
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'WebSearch', 'WebFetch', 'TaskList', 'TaskGet', 'TaskOutput', 'LS'])
const RO_BASH = /^\s*(?:cd\s+[^&;|]+&&\s*)?(?:ls|cat|head|tail|wc|grep|rg|find|pwd|echo|date|file|stat|du|which|where|type|sed\s+-n|git\s+(?:log|show|status|diff|branch|rev-parse|ls-files|blame|remote))\b/
const MODES = ['strict', 'heur']

const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.text) || '').join('\n') : '')

/** The read-only guess a mode makes for one call. */
function guessReadOnly(mode, use) {
  if (READ_ONLY_TOOLS.has(use.name)) return true
  if (mode === 'strict' || use.name !== 'Bash') return false
  const cmd = String((use.input || {}).command || '')
  return RO_BASH.test(cmd) && !/[>]|\brm\b|\bmv\b|\bcp\b/.test(cmd)
}

const rows = []
const errorHeads = {}
let notificationTurns = 0
let abortedTurns = 0
let hiddenOnly = 0

for (const dir of dirs) {
  const project = path.basename(dir)
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
    const session = name.slice(0, 8)
    const recent = { strict: [], heur: [] }
    let history = []
    let turn = null
    const tools = new Map()

    const finish = () => {
      if (turn === null) return
      const t = turn
      turn = null
      if (t.isNotification) { notificationTurns += 1; return }
      if (t.isAborted) { abortedTurns += 1; return }
      if (t.steps.size === 0) return
      for (const mode of MODES) t.c[mode].stats.steps = t.steps.size
      const s = t.c.strict.stats
      history = [...history, t.c.strict.failures].slice(-(FAILURE_WINDOW - 1))
      const out = [...t.usage.values()].reduce((n, u) => n + (u.output_tokens || 0), 0)
      const row = {
        project, session, at: t.at, model: t.model, effort: t.effort, steps: s.steps, tools: s.tools,
        edits: s.edits, errors: s.errors, refusals: s.refusals, strong: s.strong, repeated: s.repeated.length,
        editFailLoops: s.editFailLoops, outputTokens: out, prompt: t.prompt,
        errorSigs: t.c.strict.failures.map(x => x.slice(0, 60)),
      }
      for (const mode of MODES) {
        const stats = t.c[mode].stats
        recent[mode] = [...recent[mode], stats].slice(-J.WINDOW)
        const reading = J.readLevel(recent[mode])
        const j = J.judge(t.model, t.effort, reading)
        row[`readOnlyBasis_${mode}`] = `estimate:${mode}`
        row[`light_${mode}`] = J.turnSignal(stats).direction === 'down'
        row[`level_${mode}`] = reading.level
        row[`tier_${mode}`] = j.current
        row[`status_${mode}`] = j.status
        row[`target_${mode}`] = j.target
        row[`rec_${mode}`] = j.options[0] === undefined ? null : J.comboLabel(j.options[0])
      }
      rows.push(row)
    }

    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.isSidechain) continue
      const m = o.message || {}
      const content = m.content
      if (o.type === 'user') {
        const results = Array.isArray(content) ? content.filter(x => x && x.type === 'tool_result') : []
        if (results.length === 0) {
          const text = textOf(content)
          if (o.origin) {
            finish()
            const kind = o.origin.kind || ''
            turn = {
              at: o.timestamp, prompt: text.slice(0, 80).replace(/\s+/g, ' '),
              isNotification: J.isNotificationPrompt(kind, text),
              isAborted: false, steps: new Set(), usage: new Map(), model: '', effort: '-',
              c: { strict: J.newCollector(), heur: J.newCollector() },
            }
          } else if (turn !== null && /\[Request interrupted by user/.test(text)) {
            turn.isAborted = true
          }
          continue
        }
        if (turn === null) continue
        for (const r of results) {
          const use = tools.get(r.tool_use_id)
          if (!use) continue
          const before = turn.c.strict.failures.length
          for (const mode of MODES) {
            J.recordTool(turn.c[mode], J.fromTranscript(use.name, r, o.toolDenialKind, guessReadOnly(mode, use)), history.flat())
          }
          if (turn.c.strict.failures.length > before) {
            const sig = turn.c.strict.failures[before]
            errorHeads[sig.slice(0, 70)] = (errorHeads[sig.slice(0, 70)] || 0) + 1
            if (r.is_error !== true) hiddenOnly += 1
          }
        }
      } else if (o.type === 'assistant' && turn !== null) {
        if (m.id) { turn.steps.add(m.id); if (m.usage) turn.usage.set(m.id, m.usage) }
        if (m.model && m.model !== '<synthetic>') turn.model = m.model
        if (o.effort !== undefined) turn.effort = String(o.effort)
        for (const c of Array.isArray(content) ? content : []) {
          if (c && c.type === 'tool_use') tools.set(c.id, { name: c.name, input: c.input })
        }
      }
    }
    finish()
  }
}

fs.writeFileSync(outPath, JSON.stringify({ rows, notificationTurns, abortedTurns, hiddenOnly, errorHeads }))
const refusals = rows.reduce((n, r) => n + r.refusals, 0)
console.log(`turns ${rows.length}, notification turns skipped ${notificationTurns}, aborted ${abortedTurns}, hidden-only failures ${hiddenOnly}, refusals left out ${refusals}`)
console.log('read-only: estimated per mode below')
const share = n => `${Math.round((100 * n) / Math.max(rows.length, 1))}%`
for (const mode of MODES) {
  const levels = [0, 1, 2, 3].map(l => share(rows.filter(r => r[`level_${mode}`] === l).length))
  const status = s => share(rows.filter(r => r[`status_${mode}`] === s).length)
  const down = rows.filter(r => r[`status_${mode}`] === 'change' && r[`target_${mode}`] < r[`tier_${mode}`]).length
  const up = rows.filter(r => r[`status_${mode}`] === 'change' && r[`target_${mode}`] > r[`tier_${mode}`]).length
  console.log(`[estimate:${mode}] levels light/normal/heavy/very heavy ${levels.join(' ')} | fit ${status('fit')} change ${status('change')} (up ${share(up)}, down ${share(down)}) observing ${status('observing')} unsupported ${status('unsupported')} no-option ${status('no-option')}`)
}

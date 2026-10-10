// Replays the judge in hooks/judge.ts over Claude Code transcripts, read-only,
// to see what the panel would have shown on real work before changing a rule.
//
//   node --no-warnings tools/replay.mjs <out.json> <transcript dir>...
//   e.g. node --no-warnings tools/replay.mjs rows.json ~/.claude/projects/C--Desktop-my-project
//
// Set JUDGE=<path to a judge module> to replay a changed copy of the rules.
// Needs Node 23.6 or later (it imports the .ts file directly).
// Not the live plugin: transcripts carry no read-only flag, so read-only is
// guessed (mode "strict": Bash never read-only; "heur": by its first word),
// and there is no local classifier read (prior null).
import fs from 'fs'
import path from 'path'

const J = await import(process.env.JUDGE ? path.resolve(process.env.JUDGE) : new URL('../hooks/judge.ts', import.meta.url).href)

const [outPath, ...dirs] = process.argv.slice(2)
const FAILURE_WINDOW = 3
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'WebSearch', 'WebFetch', 'TaskList', 'TaskGet', 'TaskOutput', 'LS'])
const RO_BASH = /^\s*(?:cd\s+[^&;|]+&&\s*)?(?:ls|cat|head|tail|wc|grep|rg|find|pwd|echo|date|file|stat|du|which|where|type|sed\s+-n|git\s+(?:log|show|status|diff|branch|rev-parse|ls-files|blame|remote))\b/
const MODES = ['strict', 'heur']

const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.text) || '').join('\n') : '')

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
      history = [...history, t.failures].slice(-(FAILURE_WINDOW - 1))
      const out = [...t.usage.values()].reduce((n, u) => n + (u.output_tokens || 0), 0)
      const row = {
        project, session, at: t.at, model: t.model, effort: t.effort, steps: t.steps.size, tools: t.tools,
        edits: t.edits, errors: t.errors, repeated: t.repeated.length, editFailLoops: t.editFailLoops,
        outputTokens: out, prompt: t.prompt, denials: t.denials || 0, errorSigs: t.failures.map(s => s.slice(0, 60)),
      }
      for (const mode of MODES) {
        const stats = { ...J.emptyStats(), steps: t.steps.size, tools: t.tools, readOnly: t.readOnly[mode], edits: t.edits, errors: t.errors, repeated: t.repeated, editFailLoops: t.editFailLoops }
        recent[mode] = [...recent[mode], stats].slice(-J.WINDOW)
        const reading = J.readLevel(recent[mode], null)
        const rec = J.recommend(t.model, t.effort, reading, recent[mode].length)
        row[`light_${mode}`] = J.turnSignal(stats).direction === 'down'
        row[`level_${mode}`] = reading.level
        row[`tier_${mode}`] = J.tierOf(t.model, t.effort)
        row[`target_${mode}`] = rec === null ? null : rec.level
        row[`rec_${mode}`] = rec === null ? null : J.comboLabel(rec.options[0])
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
              isNotification: J.isNotificationPrompt(kind === 'task-notification' ? 'task-notification' : kind, text),
              isAborted: false, steps: new Set(), usage: new Map(), model: '', effort: '-',
              tools: 0, readOnly: { strict: 0, heur: 0 }, edits: 0, errors: 0, repeated: [], failures: [],
              editFailLoops: 0, isAfterEdit: false,
            }
          } else if (turn !== null && /\[Request interrupted by user/.test(text)) {
            turn.isAborted = true
          }
          continue
        }
        if (turn === null) continue
        if (o.toolDenialKind) turn.denials = (turn.denials || 0) + 1
        for (const r of results) {
          const use = tools.get(r.tool_use_id)
          if (!use || J.IGNORED_TOOLS.includes(use.name)) continue
          const text = textOf(r.content)
          turn.tools += 1
          const cmd = use.name === 'Bash' ? String((use.input || {}).command || '') : ''
          if (READ_ONLY_TOOLS.has(use.name)) { turn.readOnly.strict += 1; turn.readOnly.heur += 1 }
          else if (use.name === 'Bash' && RO_BASH.test(cmd) && !/[>]|\brm\b|\bmv\b|\bcp\b/.test(cmd)) turn.readOnly.heur += 1
          if (J.EDIT_TOOLS.includes(use.name)) { turn.edits += 1; turn.isAfterEdit = true }
          const hidden = r.is_error !== true && use.name === 'Bash' && J.isHiddenFailure(text)
          if (r.is_error === true || hidden) {
            if (hidden) hiddenOnly += 1
            turn.errors += 1
            const sig = J.signatureOf(use.name, text)
            const head = sig.slice(0, 70)
            errorHeads[head] = (errorHeads[head] || 0) + 1
            if ([...history.flat(), ...turn.failures].includes(sig) && !turn.repeated.includes(sig)) turn.repeated.push(sig)
            turn.failures.push(sig)
            if (use.name === 'Bash' && turn.isAfterEdit) turn.editFailLoops += 1
          }
          if (use.name === 'Bash') turn.isAfterEdit = false
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
console.log(`turns ${rows.length}, notification turns skipped ${notificationTurns}, aborted ${abortedTurns}, hidden-only failures ${hiddenOnly}`)
const share = n => `${Math.round((100 * n) / Math.max(rows.length, 1))}%`
for (const mode of MODES) {
  const levels = [0, 1, 2, 3].map(l => share(rows.filter(r => r[`level_${mode}`] === l).length))
  const fit = rows.filter(r => r[`tier_${mode}`] !== null && r[`target_${mode}`] === null).length
  const up = rows.filter(r => r[`target_${mode}`] !== null && r[`target_${mode}`] > r[`tier_${mode}`]).length
  const down = rows.filter(r => r[`target_${mode}`] !== null && r[`target_${mode}`] < r[`tier_${mode}`]).length
  console.log(`[${mode}] levels light/normal/heavy/very heavy ${levels.join(' ')} | fit ${share(fit)} down ${share(down)} up ${share(up)}`)
}

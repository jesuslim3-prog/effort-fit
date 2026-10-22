import { describe, expect, test } from 'claude-code/testing'

import {
  TARGETS,
  WINDOW,
  cacheNote,
  comboLabel,
  compactionToast,
  emptyStats,
  fromToolCall,
  fromTranscript,
  isEnvOn,
  isHiddenFailure,
  judge,
  keepsCache,
  newCollector,
  notificationTracker,
  readLevel,
  recordTool,
  shortModel,
  signatureOf,
  statusLine,
  tierOf,
  turnSignal,
  usageCounts,
  verdictText,
  type ToolEvent,
  type TurnStats,
} from '../hooks/judge'

const turn = (over: Partial<TurnStats>): TurnStats => ({ ...emptyStats(), ...over })
const light = turn({ steps: 2, tools: 1, readOnly: 1 })
const quiet = turn({ steps: 1 })
const failing = turn({ steps: 6, tools: 4, errors: 2, strong: 1 })
const has = (text: string, part: string): boolean => text.includes(part)

const event = (tool: string, text: string, isError: boolean, isRefused = false): ToolEvent => ({ tool, text, isError, isRefused, isReadOnly: false })
const fail = (text: string): ToolEvent => event('Bash', text, true)
const edit = event('Edit', 'ok', false)
const run = (events: ToolEvent[], earlier: readonly string[] = []) => {
  const c = newCollector()
  for (const e of events) {
    recordTool(c, e, earlier)
  }

  return c
}

describe('effort-fit judge', () => {
  test('every TARGETS entry sits on its own level in TIER', async () => {
    const ids = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' }
    TARGETS.forEach((combos, level) => {
      for (const c of combos) {
        expect(tierOf(ids[c.family], c.effort)).toBe(level)
      }
    })
  })

  test('a recommendation never repeats the session\'s combo or falls short of its target', async () => {
    const heavy = readLevel([failing])
    const opus46 = judge('claude-opus-4-6', 'high', heavy)
    expect(opus46.status).toBe('change')
    expect(opus46.options).toEqual([{ family: 'opus', effort: 'max' }])
    expect(judge('claude-opus-5-5', 'high', heavy).options).toEqual([{ family: 'opus', effort: 'xhigh' }])
    expect(judge('claude-opus-5-5', 'xhigh', heavy).status).toBe('fit')
    const settled = readLevel([failing, light, light, light])
    const none = judge('claude-opus-4-6', 'max', settled)
    expect(none.status).toBe('no-option')
    expect(has(none.reason, '무거움')).toBe(true)
    expect(judge('some-other-model', 'high', heavy).status).toBe('unsupported')
    expect(judge('claude-opus-5-5', '-', heavy).status).toBe('unsupported')
  })

  test('strong evidence goes straight to the target, weak evidence one step, and the step is named as limited', async () => {
    const piling = readLevel([turn({ steps: 6, tools: 4, errors: 3, strong: 3 })])
    expect(judge('claude-haiku-5-5', 'medium', piling).options[0]).toEqual({ family: 'fable', effort: 'high' })
    const once = judge('claude-haiku-5-5', 'medium', readLevel([failing]))
    expect([once.target, once.isStepLimited]).toEqual([1, true])
    expect(has(verdictText(once, 2), '한 단계만')).toBe(true)
  })

  test('a held step down shows as observing, never as fit, and the status line names the detected level the panel does', async () => {
    const two = readLevel([light, light])
    const held = judge('claude-opus-5-5', 'xhigh', two)
    expect(held.status).toBe('observing')
    expect(has(verdictText(held, two.level), '추가 관찰 중')).toBe(true)
    expect(has(verdictText(held, two.level), '적합')).toBe(false)
    const three = readLevel([light, light, light])
    const limited = judge('claude-opus-5-5', 'xhigh', three)
    expect([limited.status, limited.target, limited.isStepLimited]).toEqual(['change', 1, true])
    const view = {
      model: 'claude-opus-5-5', effort: 'xhigh', level: three.level, current: limited.current, target: limited.target,
      status: limited.status, statusReason: limited.reason, isStepLimited: limited.isStepLimited,
      options: limited.options.map(c => ({ ...c, isModelSwitch: true, keepsCache: false })),
      reasons: three.reasons, contextTokens: null,
    }
    expect(has(statusLine(view), '감지 가벼움')).toBe(true)
    expect(has(statusLine({ ...view, status: 'observing', options: [] }), '추가 관찰 중 (감지 가벼움)')).toBe(true)
  })

  test('a turn without tools is neither light nor heavy, so quiet turns hold a step down; a small error-free turn of any tools is light, long read-only digging is not', async () => {
    expect(turnSignal(quiet).direction).toBe('keep')
    expect(turnSignal(light).direction).toBe('down')
    expect(turnSignal(turn({ steps: 2, tools: 2, readOnly: 0 })).direction).toBe('down')
    expect(turnSignal(turn({ steps: 2, tools: 2, errors: 1 })).direction).toBe('keep')
    const digging = turn({ steps: 8, tools: 8, readOnly: 8 })
    expect(turnSignal(digging).direction).toBe('keep')
    for (const n of [3, 4, 5]) {
      expect(judge('claude-opus-5-5', 'xhigh', readLevel(Array(n).fill(quiet))).status).toBe('observing')
    }
    expect(judge('claude-opus-5-5', 'xhigh', readLevel([digging, digging, digging])).status).toBe('observing')
    expect(judge('claude-opus-5-5', 'xhigh', readLevel([light, light, light, digging, digging])).status).toBe('change')
  })

  test('a failed result is one event: strong once when it repeats a recent failure or is a second-or-later failure right after an edit', async () => {
    const twice = run([fail('E a'), fail('E a')]).stats
    expect([twice.errors, twice.strong, twice.repeated.length]).toEqual([2, 1, 1])
    const first = run([fail('E a')])
    expect(first.stats.strong).toBe(0)
    expect(run([fail('E a')], first.failures).stats.strong).toBe(1)
    expect(run([fail('E a')], []).stats.strong).toBe(0)
    const loops = (n: number) => run(['a', 'b', 'c'].slice(0, n).flatMap(x => [edit, fail(`T ${x}`)])).stats.strong
    expect([loops(1), loops(2), loops(3)]).toEqual([0, 1, 2])
    expect(run([edit, fail('X'), edit, fail('X')]).stats.strong).toBe(1)
    expect(run([fail('A'), fail('B')]).stats.strong).toBe(0)
    const outOfWindow = readLevel([failing, light, light, light, light, light].slice(-WINDOW))
    expect(outOfWindow.strong).toBe(0)
  })

  test('a refusal is counted apart: not a tool call, an error or a repeat', async () => {
    const refused = run([
      fail('Permission for this action was denied by the Claude Code auto mode classifier.'),
      fail('Permission for this action was denied by the Claude Code auto mode classifier.'),
      event('Bash', 'Remove-Item on system path is blocked.', true, true),
      event('AskUserQuestion', "The user doesn't want to proceed with this tool use.", true),
    ]).stats
    expect([refused.refusals, refused.tools, refused.errors, refused.strong]).toEqual([4, 0, 0, 0])
  })

  test('the live path and the replay path agree on the same results, two refusals included', async () => {
    type Raw = { tool: string; text: string; isError: boolean; denialKind?: string; isReadOnly: boolean }
    const denied = 'Permission to use Bash with command rm x has been denied.'
    const turns: Raw[][] = [
      [{ tool: 'Read', text: 'a', isError: false, isReadOnly: true }, { tool: 'Bash', text: denied, isError: true, denialKind: 'permission-rule', isReadOnly: false }, { tool: 'Bash', text: denied, isError: true, denialKind: 'permission-rule', isReadOnly: false }],
      [{ tool: 'Bash', text: 'boom', isError: true, isReadOnly: false }, { tool: 'Bash', text: 'boom', isError: true, isReadOnly: false }],
      [{ tool: 'Grep', text: 'hit', isError: false, isReadOnly: true }],
    ]
    const replay = (toEvent: (r: Raw) => ToolEvent) => {
      let history: string[][] = []
      const window: TurnStats[] = []

      return turns.map(raws => {
        const c = newCollector()
        c.stats.steps = 2
        for (const r of raws) {
          recordTool(c, toEvent(r), history.flat())
        }
        history = [...history, c.failures].slice(-2)
        window.push(c.stats)
        const reading = readLevel(window.slice(-WINDOW))
        const j = judge('claude-opus-5-5', 'high', reading)
        const s = c.stats

        return [s.errors, s.refusals, s.repeated.length, reading.level, j.status, j.options[0] === undefined ? null : comboLabel(j.options[0])]
      })
    }
    const live = replay(r => fromToolCall(r.tool, { isError: r.isError, isReadOnly: r.isReadOnly, text: r.text }))
    const transcript = replay(r => fromTranscript(r.tool, { is_error: r.isError, content: [{ type: 'text', text: r.text }] }, r.denialKind, r.isReadOnly))
    expect(live).toEqual(transcript)
    expect(live[0]?.slice(0, 2)).toEqual([0, 2])
    expect(live[1]?.[3]).toBe(2)
  })

  test('cache notes say only what the docs vouch for, and mark the token count as an estimate', async () => {
    expect(cacheNote({ isModelSwitch: false, keepsCache: true }, 57000)).toBe('effort만 변경 · 캐시 유지 (공식 문서 기준)')
    const model = cacheNote({ isModelSwitch: true, keepsCache: false }, 57400)
    expect([has(model, '모델 전환'), has(model, '약 57k'), has(model, '추정')]).toEqual([true, true, true])
    expect(has(cacheNote({ isModelSwitch: false, keepsCache: false }, 1000), 'effort 변경')).toBe(true)
    expect(has(cacheNote({ isModelSwitch: true, keepsCache: false }, null), '알 수 없음')).toBe(true)
    const toast = compactionToast('Fable·high')
    expect([has(toast, '손실 없이'), has(toast, '가장 적습니다')]).toEqual([false, true])
  })

  test('an effort change keeps the cache on 5.5-generation models off third-party providers, a model switch never', async () => {
    expect(keepsCache({ family: 'opus', effort: 'xhigh' }, 'claude-opus-5-5', false)).toBe(true)
    expect(keepsCache({ family: 'fable', effort: 'low' }, 'claude-fable-5-1', false)).toBe(true)
    expect(keepsCache({ family: 'opus', effort: 'xhigh' }, 'claude-opus-5-5', true)).toBe(false)
    expect(keepsCache({ family: 'sonnet', effort: 'xhigh' }, 'claude-sonnet-5', false)).toBe(false)
    expect(keepsCache({ family: 'sonnet', effort: 'high' }, 'claude-opus-5-5', false)).toBe(false)
    expect([undefined, '', '0', 'false', '1'].map(isEnvOn)).toEqual([false, false, false, false, true])
  })

  test('a Bash failure hidden behind a trailing command counts: a non-zero exit last line, or bash\'s command-not-found line', async () => {
    expect(isHiddenFailure('/usr/bin/bash: line 1: foo-not-exist: command not found\nexit=127')).toBe(true)
    expect(isHiddenFailure('bash: foo: command not found\ndone')).toBe(true)
    expect(isHiddenFailure('built\nExit code: 2')).toBe(true)
    expect(isHiddenFailure('built\nexit=0')).toBe(false)
    expect(isHiddenFailure('exit=1\nall good')).toBe(false)
    expect(isHiddenFailure('the docs say: command not found errors mean a missing PATH entry')).toBe(false)
    expect(isHiddenFailure(undefined)).toBe(false)
  })

  test('usage counts carry the turn totals, nulls when the turn reported none', async () => {
    const usage = { input_tokens: 3, output_tokens: 120, cache_read_input_tokens: 9000, cache_creation_input_tokens: 40 }
    expect(usageCounts(usage)).toEqual({ inputTokens: 3, outputTokens: 120, cacheReadTokens: 9000, cacheCreationTokens: 40 })
    expect(usageCounts(undefined).outputTokens).toBe(null)
  })

  test('failure signatures ignore numbers and spacing, and tell different Bash errors apart', async () => {
    expect(signatureOf('Bash', '\nline 12:  assert failed')).toBe(signatureOf('Bash', 'line 40: assert failed'))
    const missing = 'Exit code 1\nTraceback (most recent call last):\r\n  File "<string>", line 1\r\nModuleNotFoundError: No module named \'a\''
    const syntax = 'Exit code 1\nTraceback (most recent call last):\r\n  File "<string>", line 5\r\nSyntaxError: invalid syntax'
    expect(signatureOf('Bash', missing)).toBe(signatureOf('Bash', missing.replace('line 1', 'line 9')))
    expect(signatureOf('Bash', missing) === signatureOf('Bash', syntax)).toBe(false)
  })

  test('a turn started by a task notification is told apart, one folded into a running turn is not', async () => {
    const tracker = notificationTracker()
    tracker.submitted('task-notification', '<task-notification>')
    tracker.turnStarted()
    expect(tracker.isNotificationTurn()).toBe(true)
    tracker.submitted('peer', 'Another Claude session sent a message:\n[Subagent hand-back] The text below')
    tracker.turnStarted()
    expect(tracker.isNotificationTurn()).toBe(true)
    tracker.submitted('peer', 'Another Claude session sent a message:\nplease review')
    tracker.turnStarted()
    expect(tracker.isNotificationTurn()).toBe(false)
    tracker.submitted('composer', 'fix it')
    tracker.turnStarted()
    tracker.submitted('task-notification', '<task-notification>')
    expect(tracker.isNotificationTurn()).toBe(false)
  })

  test('helpers read model names', async () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
  })
})

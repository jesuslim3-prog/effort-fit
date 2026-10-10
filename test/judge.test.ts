import { describe, expect, test } from 'claude-code/testing'

import {
  emptyStats,
  isEnvOn,
  isHiddenFailure,
  keepsCache,
  notificationTracker,
  parsePrior,
  priorTracker,
  readLevel,
  recommend,
  runnable,
  shortModel,
  signatureOf,
  tierOf,
  usageCounts,
} from '../hooks/judge'

const failing = { ...emptyStats(), steps: 6, tools: 4, errors: 2, repeated: ['Bash: x'] }
const light = { ...emptyStats(), steps: 2, tools: 2, readOnly: 2 }

describe('effort-fit judge', () => {
  test('a repeated failure reads heavy at once, three strong events very heavy, and Haiku·medium goes straight to Fable·high', async () => {
    expect(readLevel([failing], null).level).toBe(2)
    const piling = readLevel([{ ...failing, repeated: ['Bash: x', 'Bash: y'], editFailLoops: 2 }], null)
    expect(piling.level).toBe(3)
    expect(recommend('claude-haiku-5-5', 'medium', piling, 1)?.options[0]).toEqual({ family: 'fable', effort: 'high' })
  })

  test('weak evidence moves one level toward the read; going down waits three turns, and a full window to skip a level', async () => {
    expect(recommend('claude-haiku-5-5', 'medium', readLevel([failing], null), 1)?.level).toBe(1)
    expect(recommend('claude-opus-5-5', 'high', readLevel([light, light], null), 2)).toBe(null)
    expect(recommend('claude-opus-5-5', 'high', readLevel([light, light, light], null), 3)?.level).toBe(1)
    const five = readLevel([light, light, light, light, light], null)
    expect(recommend('claude-opus-5-5', 'high', five, 5)?.options[0]).toEqual({ family: 'haiku', effort: 'medium' })
  })

  test('a light read needs three light turns, two with a light prior, none with a heavy one; a fitting combo gets nothing', async () => {
    expect(readLevel([light, light], null).level).toBe(1)
    expect(readLevel([light, light], 'light').level).toBe(0)
    expect(readLevel([light, light, light], 'heavy').level).toBe(1)
    expect(recommend('claude-sonnet-5-5', 'high', readLevel([light], null), 1)).toBe(null)
    expect(tierOf('some-other-model', 'high')).toBe(null)
  })

  test('on a model without xhigh, an xhigh combo falls back to high and a repeat is dropped', async () => {
    expect(recommend('claude-opus-4-6', 'medium', readLevel([failing], null), 1)?.options).toEqual([{ family: 'opus', effort: 'high' }])
    expect(runnable([{ family: 'opus', effort: 'xhigh' }], 'claude-opus-5-5')).toEqual([{ family: 'opus', effort: 'xhigh' }])
  })

  test('a classifier read belongs to the prompt it was asked for; a notification in between does not drop it, a newer prompt does', async () => {
    const priors = priorTracker()
    const first = priors.submitted()
    priors.resolved(first, 'light')
    expect(priors.current()).toBe('light')
    priors.submitted()
    expect(priors.current()).toBe(null)
    priors.resolved(first, 'heavy')
    expect(priors.current()).toBe(null)
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

  test('helpers read model names and Ollama replies', async () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(parsePrior(JSON.stringify({ response: '{"level":"heavy"}' }))).toBe('heavy')
    expect(parsePrior('not json')).toBe(null)
  })
})

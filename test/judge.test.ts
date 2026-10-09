import { describe, expect, test } from 'claude-code/testing'

import {
  advance,
  decide,
  emptyStats,
  holdUp,
  notificationTracker,
  parsePrior,
  shortModel,
  signatureOf,
  suggest,
  turnSignal,
} from '../hooks/judge'

describe('effort-fit judge', () => {
  test('a repeated failure recommends going up at once', async () => {
    const signal = turnSignal({ ...emptyStats(), steps: 9, tools: 6, errors: 2, repeated: ['Bash: x'] })
    expect(signal.direction).toBe('up')
    expect(decide(advance({ direction: 'keep', count: 0 }, signal.direction), null)).toBe('up')
  })

  test('light turns recommend going down only after three in a row, two with a light prior, never with a heavy one', async () => {
    const light = turnSignal({ ...emptyStats(), steps: 2, tools: 2, readOnly: 2 }).direction
    expect(light).toBe('down')
    let streak = advance({ direction: 'keep', count: 0 }, light)
    streak = advance(streak, light)
    expect(decide(streak, null)).toBe('keep')
    expect(decide(streak, 'light')).toBe('down')
    streak = advance(streak, light)
    expect(decide(streak, null)).toBe('down')
    expect(decide(streak, 'heavy')).toBe('keep')
  })

  test('a ▲ stays three turns, restarts on a fresh ▲, and ends when model or effort changes', async () => {
    let step = holdUp('up', null, 'opus|high')
    const shown = [step.shown]
    for (const decided of ['down', 'keep', 'down'] as const) {
      step = holdUp(decided, step.hold, 'opus|high')
      shown.push(step.shown)
    }
    expect(shown).toEqual(['up', 'up', 'up', 'down'])

    step = holdUp('up', null, 'opus|high')
    step = holdUp('keep', step.hold, 'opus|high')
    step = holdUp('up', step.hold, 'opus|high')
    expect(step.hold?.left).toBe(2)

    step = holdUp('keep', step.hold, 'opus|xhigh')
    expect(step.shown).toBe('keep')
  })

  test('suggestions walk the effort ladder, then the model', async () => {
    expect(suggest('up', 'claude-sonnet-5-5', 'high')).toBe('effort xhigh')
    expect(suggest('up', 'claude-sonnet-5-5', 'max')).toBe('Opus 모델')
    expect(suggest('down', 'claude-opus-5-5', 'medium')).toBe('effort low')
    expect(suggest('down', 'claude-opus-5-5', 'low')).toBe('Sonnet 모델')
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

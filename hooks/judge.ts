import type { Direction, Prior } from '../types'

export const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Model families, least capable first; a suggestion moves one step once the
 * effort ladder runs out. Fable is the most capable (code.claude.com/docs/en/model-config).
 */
export const MODEL_LADDER = ['Haiku', 'Sonnet', 'Opus', 'Fable'] as const

export const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

/** Calls every loop of a kind makes, which say nothing about the work: a subagent's closing handback. */
export const IGNORED_TOOLS = ['SubagentHandback']

/** Turns a signal must hold in a row before the recommendation changes. */
export const UP_AFTER = 1
export const DOWN_AFTER = 3

export type TurnStats = {
  /** Model requests in the turn. */
  steps: number
  tools: number
  readOnly: number
  edits: number
  errors: number
  /** Failure signatures seen at least twice in the recent window. */
  repeated: string[]
  /** An edit followed by a failing command. */
  editFailLoops: number
}

export type Streak = { direction: Direction; count: number }

/** Turns a shown ▲ stays, the turn it appeared on included. */
export const UP_HOLD = 3

/** A ▲ still being held: turns left after this one, and the model·effort it was raised against. */
export type UpHold = { left: number; setting: string }

/**
 * Keeps a ▲ on screen for UP_HOLD turns. A fresh ▲ starts the count again;
 * a change of model or effort ends it, the advice having been taken.
 */
export function holdUp(decided: Direction, hold: UpHold | null, setting: string): { shown: Direction; hold: UpHold | null } {
  if (decided === 'up') {
    return { shown: 'up', hold: { left: UP_HOLD - 1, setting } }
  }
  if (hold !== null && hold.left > 0 && hold.setting === setting) {
    return { shown: 'up', hold: { left: hold.left - 1, setting } }
  }

  return { shown: decided, hold: null }
}

/**
 * A background task's notification, or a subagent's hand-back report, which
 * arrives as a peer message (its origin carries no hand-back flag here, so
 * the frame's marker in the text tells it from another session's message).
 */
export function isNotificationPrompt(originKind: string, text: string): boolean {
  return originKind === 'task-notification' || (originKind === 'peer' && text.includes('[Subagent hand-back]'))
}

/**
 * Whether the main turn now running was started by a background task's
 * notification rather than by work asked for. Fixed when the turn's first
 * request goes out, so a notification folded into a running turn changes
 * nothing about that turn.
 */
export function notificationTracker() {
  let isLastNotification = false
  let isCurrent = false

  return {
    submitted: (originKind: string, text: string) => {
      isLastNotification = isNotificationPrompt(originKind, text)
    },
    turnStarted: () => {
      isCurrent = isLastNotification
    },
    isNotificationTurn: () => isCurrent,
  }
}

export const emptyStats = (): TurnStats => ({
  steps: 0,
  tools: 0,
  readOnly: 0,
  edits: 0,
  errors: 0,
  repeated: [],
  editFailLoops: 0,
})

const fold = (line: string): string => line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 100)

/**
 * A failure's first and last meaningful lines, numbers and spacing folded, so
 * reruns of one error match. Bash's "Exit code N" lead line says nothing about
 * which error it was, and a traceback names its error on the last line.
 */
export function signatureOf(tool: string, text: string | undefined): string {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !/^exit code \d+$/i.test(line))
  const first = fold(lines[0] ?? '')
  const last = fold(lines[lines.length - 1] ?? '')

  return first === last ? `${tool}: ${first}` : `${tool}: ${first} … ${last}`
}

export function turnSignal(s: TurnStats): { direction: Direction; reasons: string[] } {
  const up: string[] = []
  if (s.repeated.length > 0) {
    up.push(`같은 실패 반복 (${s.repeated[0]})`)
  }
  if (s.editFailLoops >= 2) {
    up.push(`수정 후 실패 ${s.editFailLoops}회`)
  }
  if (up.length > 0) {
    return { direction: 'up', reasons: up }
  }

  const isOnlyReading = s.readOnly >= s.tools - s.edits
  const isLight = s.errors === 0 && s.edits <= 1 && s.steps <= 4 && isOnlyReading
  if (isLight) {
    return { direction: 'down', reasons: [`가벼운 턴 (${s.steps}단계, 편집 ${s.edits}, 오류 0)`] }
  }

  return { direction: 'keep', reasons: [] }
}

/** A streak counts turns at one model·effort: a change starts it over, the advice having been taken. */
export function sinceChange(streak: Streak, before: string, now: string): Streak {
  return before === now ? streak : { direction: 'keep', count: 0 }
}

export function advance(prev: Streak, direction: Direction): Streak {
  return prev.direction === direction
    ? { direction, count: prev.count + 1 }
    : { direction, count: 1 }
}

/**
 * Whether the streak is long enough to recommend. The prior only shortens or
 * blocks a downgrade: failures are facts, a prompt's look is not.
 */
export function decide(streak: Streak, prior: Prior | null): Direction {
  if (streak.direction === 'up') {
    return streak.count >= UP_AFTER ? 'up' : 'keep'
  }
  if (streak.direction === 'down') {
    if (prior === 'heavy') {
      return 'keep'
    }
    const needed = prior === 'light' ? DOWN_AFTER - 1 : DOWN_AFTER

    return streak.count >= needed ? 'down' : 'keep'
  }

  return 'keep'
}

export function suggest(direction: Direction, model: string, effort: string): string | null {
  const i = (LADDER as readonly string[]).indexOf(effort)
  const m = MODEL_LADDER.findIndex(family => model.toLowerCase().includes(family.toLowerCase()))
  if (direction === 'up') {
    if (i >= 0 && i < LADDER.length - 1) {
      return `effort ${LADDER[i + 1]}`
    }

    return m >= 0 && m < MODEL_LADDER.length - 1 ? `${MODEL_LADDER[m + 1]} 모델` : null
  }
  if (direction === 'down') {
    if (i > 0) {
      return `effort ${LADDER[i - 1]}`
    }

    return m > 0 ? `${MODEL_LADDER[m - 1]} 모델` : null
  }

  return null
}

/**
 * Models on which changing effort keeps the prompt cache on Anthropic's own
 * API (code.claude.com/docs/en/prompt-caching, "Changing effort level").
 */
const EFFORT_KEEPS_CACHE = /(?:opus|sonnet|haiku)-5-5(?!\d)|fable-5-1(?!\d)/i

/** An environment switch counts as on unless unset, empty, "0" or "false". */
export const isEnvOn = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'

/**
 * Whether taking the suggestion now keeps the prompt cache: only an effort
 * change, on a model that keeps it, off the providers where it does not.
 * A model switch always starts a fresh cache.
 */
export function keepsCache(suggestion: string, model: string, isEffortCacheBroken: boolean): boolean {
  return suggestion.startsWith('effort ') && !isEffortCacheBroken && EFFORT_KEEPS_CACHE.test(model)
}

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** A turn's summed token counts for the log; nulls when it reported none (an interrupt, an API error). */
export function usageCounts(usage: Usage | undefined) {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    cacheReadTokens: usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? null,
  }
}

/** "claude-opus-5-5" → "Opus 5.5"; anything else as given. */
export function shortModel(model: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(model)
  if (m === null) {
    return model
  }
  const [, family = '', major = '', minor = ''] = m

  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}.${minor}`
}

export function parsePrior(responseText: string): Prior | null {
  try {
    const outer = JSON.parse(responseText) as { response?: string }
    const inner = JSON.parse(outer.response ?? '') as { level?: string }
    const level = inner.level

    return level === 'light' || level === 'normal' || level === 'heavy' ? level : null
  } catch {
    return null
  }
}

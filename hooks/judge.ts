import type { Combo, Direction, Family, Prior } from '../types'

export const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Model families, least capable first (code.claude.com/docs/en/model-config: Fable is the most capable). */
export const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const

export const LEVEL_NAMES = ['가벼움', '보통', '무거움', '매우 무거움'] as const

/**
 * The level each model·effort serves, by effort low…max. An assumption to
 * calibrate against the log, as TARGETS is; the two agree with each other.
 */
const TIER: Record<Family, readonly number[]> = {
  haiku: [0, 0, 0, 1, 1],
  sonnet: [0, 1, 1, 1, 2],
  opus: [1, 1, 2, 2, 3],
  fable: [2, 2, 3, 3, 3],
}

/** What each level recommends, then the alternative. */
export const TARGETS: readonly (readonly [Combo, Combo])[] = [
  [{ family: 'haiku', effort: 'medium' }, { family: 'sonnet', effort: 'low' }],
  [{ family: 'sonnet', effort: 'high' }, { family: 'opus', effort: 'medium' }],
  [{ family: 'opus', effort: 'xhigh' }, { family: 'opus', effort: 'high' }],
  [{ family: 'fable', effort: 'high' }, { family: 'opus', effort: 'max' }],
]

/** Main turns the level is read over. */
export const WINDOW = 5
/** Turns needed before recommending a lower level. */
export const DOWN_AFTER = 3

export const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

/** Calls every loop of a kind makes, which say nothing about the work: a subagent's closing handback. */
export const IGNORED_TOOLS = ['SubagentHandback']

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

/**
 * The local classifier's read of the prompt now being worked on. Only work
 * asked for moves it on (`submitted`), so a notification folded into a
 * running turn leaves that turn's read in place; a late read of an older
 * prompt is dropped.
 */
export function priorTracker() {
  let seq = 0
  let held: { seq: number; level: Prior } | null = null

  return {
    submitted: (): number => (seq += 1),
    resolved: (at: number, level: Prior) => {
      if (at === seq) {
        held = { seq: at, level }
      }
    },
    current: (): Prior | null => (held !== null && held.seq === seq ? held.level : null),
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

/** A last line that names a non-zero exit code: "exit=127", "Exit code: 2", "exit status 1". */
const EXIT_LINE = /^(?:exit|exit code|exit status|return code|rc)\s*[:=]?\s*[1-9]\d*$/i

/** Bash's own complaint about a missing command: "/usr/bin/bash: line 1: foo: command not found". */
const NOT_FOUND_LINE = /^(?:\S*\/)?(?:ba)?sh: (?:line \d+: )?\S+: command not found$/

/**
 * A Bash failure the result does not flag, because the command went on after
 * it (`foo; echo "exit=$?"` ends in success): a last line naming a non-zero
 * exit code, or bash's command-not-found line anywhere.
 */
export function isHiddenFailure(text: string | undefined): boolean {
  const lines = (text ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const last = lines[lines.length - 1] ?? ''

  return EXIT_LINE.test(last) || lines.some(line => NOT_FOUND_LINE.test(line))
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

/** A turn of sizeable work: many model requests or many edits. */
const isHeavyTurn = (s: TurnStats): boolean => s.steps >= 10 || s.edits >= 3

/** Facts that the work is going badly: a failure seen again, edits that keep failing. */
const strongEvents = (s: TurnStats): number => s.repeated.length + (s.editFailLoops >= 2 ? 1 : 0)

export type Reading = { level: number; strong: number; reasons: string[] }

/**
 * The level the last WINDOW main turns ask for. Failures are facts; the
 * prompt's look (prior) only tips a borderline window.
 */
export function readLevel(window: readonly TurnStats[], prior: Prior | null): Reading {
  const strong = window.reduce((n, s) => n + strongEvents(s), 0)
  const heavy = window.filter(isHeavyTurn).length
  const light = window.filter(s => turnSignal(s).direction === 'down').length
  const reasons: string[] = []
  if (strong > 0) {
    reasons.push(`최근 ${window.length}턴에 반복 실패·수정 후 실패 ${strong}회`)
  }
  if (heavy > 0) {
    reasons.push(`큰 작업 턴 ${heavy}회`)
  }
  if (strong >= 3) {
    return { level: 3, strong, reasons }
  }
  if (strong >= 1 || heavy >= 2 || (prior === 'heavy' && heavy >= 1)) {
    return { level: 2, strong, reasons }
  }
  const lightNeeded = prior === 'light' ? DOWN_AFTER - 1 : DOWN_AFTER
  if (prior !== 'heavy' && window.length >= lightNeeded && light === window.length) {
    return { level: 0, strong, reasons: [`가벼운 턴 ${light}회 연속`] }
  }

  return { level: 1, strong, reasons: reasons.length > 0 ? reasons : [`최근 ${window.length}턴에 실패 반복·큰 작업 없음`] }
}

export const familyOf = (model: string): Family | null =>
  FAMILIES.find(family => model.toLowerCase().includes(family)) ?? null

/** The level the session's model·effort serves; null for a model or effort off the table. */
export function tierOf(model: string, effort: string): number | null {
  const family = familyOf(model)
  const i = (LADDER as readonly string[]).indexOf(effort)

  return family === null || i < 0 ? null : (TIER[family][i] ?? null)
}

/**
 * The level to recommend from where the session sits: straight to the level
 * read when the evidence is strong, else one step toward it, so one spiky or
 * quiet stretch does not swing the session across the table. Going down waits
 * for DOWN_AFTER turns, and for a full window to go more than one step.
 */
export function targetLevel(current: number, reading: Reading, turns: number): number {
  const { level, strong } = reading
  if (level < current && turns < DOWN_AFTER) {
    return current
  }
  if (Math.abs(level - current) < 2) {
    return level
  }
  const isSure = level > current ? strong >= 2 : turns >= WINDOW

  return isSure ? level : current + Math.sign(level - current)
}

/** Models without the xhigh effort level (code.claude.com/docs/en/model-config). */
const NO_XHIGH = /(?:opus|sonnet)-4-6(?!\d)/i

/** The combos as the session's model generation can run them: xhigh falls back to high where it does not exist, a repeat dropped. */
export function runnable(options: readonly Combo[], model: string): Combo[] {
  if (!NO_XHIGH.test(model)) {
    return [...options]
  }
  const out: Combo[] = []
  for (const option of options) {
    const combo: Combo = option.effort === 'xhigh' ? { ...option, effort: 'high' } : option
    if (!out.some(c => c.family === combo.family && c.effort === combo.effort)) {
      out.push(combo)
    }
  }

  return out
}

/** The recommended combos and the level they serve, or null when the session already sits there. */
export function recommend(model: string, effort: string, reading: Reading, turns: number) {
  const current = tierOf(model, effort)
  if (current === null) {
    return null
  }
  const level = targetLevel(current, reading, turns)

  return level === current ? null : { level, options: runnable(TARGETS[level] ?? [], model) }
}

/** "Fable·high". */
export const comboLabel = (c: Combo): string => `${c.family.charAt(0).toUpperCase()}${c.family.slice(1)}·${c.effort}`

/**
 * Models on which changing effort keeps the prompt cache on Anthropic's own
 * API (code.claude.com/docs/en/prompt-caching, "Changing effort level").
 */
const EFFORT_KEEPS_CACHE = /(?:opus|sonnet|haiku)-5-5(?!\d)|fable-5-1(?!\d)/i

/** An environment switch counts as on unless unset, empty, "0" or "false". */
export const isEnvOn = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'

/**
 * Whether moving to the combo now keeps the prompt cache: only an effort
 * change, on a model that keeps it, off the providers where it does not.
 * A model switch always starts a fresh cache.
 */
export function keepsCache(combo: Combo, model: string, isEffortCacheBroken: boolean): boolean {
  return familyOf(model) === combo.family && !isEffortCacheBroken && EFFORT_KEEPS_CACHE.test(model)
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

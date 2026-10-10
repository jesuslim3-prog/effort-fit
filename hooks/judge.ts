import type { Combo, Direction, FitView, Family, Prior, Status } from '../types'

export const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Model families, least capable first (code.claude.com/docs/en/model-config: Fable is the most capable). */
export const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const

export const LEVEL_NAMES = ['가벼움', '보통', '무거움', '매우 무거움'] as const

/**
 * The level each model·effort serves, by effort low…max. An assumption to
 * calibrate against the log, as TARGETS is. Opus·high counts as normal: a
 * replay of 6,758 real turns, nine in ten on Opus·high, read normal most of
 * the time, and ranking Opus·high heavy advised stepping down on 69% of them.
 */
const TIER: Record<Family, readonly number[]> = {
  haiku: [0, 0, 0, 1, 1],
  sonnet: [0, 1, 1, 1, 2],
  opus: [1, 1, 1, 2, 3],
  fable: [2, 2, 3, 3, 3],
}

/**
 * What each level recommends, then an alternative; every entry sits on its
 * own level in TIER (a test holds the two together). Heavy has no
 * alternative since Opus·high moved to normal.
 */
export const TARGETS: readonly (readonly Combo[])[] = [
  [{ family: 'haiku', effort: 'medium' }, { family: 'sonnet', effort: 'low' }],
  [{ family: 'sonnet', effort: 'high' }, { family: 'opus', effort: 'medium' }],
  [{ family: 'opus', effort: 'xhigh' }],
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
  /** Failure signatures seen again within the recent window, each once. */
  repeated: string[]
  /** Failing Bash runs right after an edit. */
  editFailLoops: number
  /** Failed results that are a repeat of a recent failure, or a second-or-later failure right after an edit; each failed result counts at most once. */
  strong: number
  /** Results refused before they showed anything about the work (permission rules, the user, a hook); left out of tools and errors. */
  refusals: number
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
  strong: 0,
  refusals: 0,
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

/**
 * Claude Code's own wording when a call is refused rather than run: a
 * permission rule or auto mode, the user, an interruption, a hook.
 */
const REFUSAL = /^(?:Permission (?:for this (?:action|command)|to use .+?) (?:was|has been) denied|The user doesn't want to (?:proceed with this tool use|take this action right now)|\[Request interrupted by user for tool use\]|The server-side auto mode classifier gave no verdict|PreToolUse:\S+ hook error)/

export const isRefusalText = (text: string | undefined): boolean => REFUSAL.test((text ?? '').trimStart())

/** One tool result, from the live hook or from a transcript. */
export type ToolEvent = {
  tool: string
  text: string | undefined
  isError: boolean
  /** Refused by a marker the source carries: a plugin's deny, a transcript's denial kind. */
  isRefused: boolean
  /** Claude Code's own read-only check; a transcript only has a guess. */
  isReadOnly: boolean | undefined
}

/** A live `tool.call` result. */
export const fromToolCall = (
  tool: string,
  ran: { deny?: string; isError?: boolean; isReadOnly?: boolean; text?: string },
): ToolEvent => ({ tool, text: ran.text, isError: ran.isError === true, isRefused: ran.deny !== undefined, isReadOnly: ran.isReadOnly })

/** A transcript's `tool_result`, with the entry's `toolDenialKind` and a guessed read-only flag. */
export function fromTranscript(
  tool: string,
  result: { is_error?: boolean; content?: unknown },
  denialKind: string | undefined,
  isReadOnly: boolean,
): ToolEvent {
  const c = result.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x as { text?: string } | null)?.text ?? '').join('\n') : undefined

  return { tool, text, isError: result.is_error === true, isRefused: denialKind !== undefined, isReadOnly }
}

/** One loop's running count of a turn. */
export type Collector = { stats: TurnStats; failures: string[]; isAfterEdit: boolean }

export const newCollector = (): Collector => ({ stats: emptyStats(), failures: [], isAfterEdit: false })

/**
 * Counts one tool result into the turn; the live hook and tools/replay.mjs
 * both go through here. A refusal is counted apart and nothing else. A failed
 * result is one event: strong once if it repeats a failure from this turn or
 * `earlier` (the last turns' signatures), or is the second-or-later failure
 * right after an edit in the turn, never twice.
 */
export function recordTool(c: Collector, e: ToolEvent, earlier: readonly string[]): void {
  if (IGNORED_TOOLS.includes(e.tool)) {
    return
  }
  const s = c.stats
  if (e.isRefused || isRefusalText(e.text)) {
    s.refusals += 1
    return
  }
  s.tools += 1
  if (e.isReadOnly === true) {
    s.readOnly += 1
  }
  if (EDIT_TOOLS.includes(e.tool)) {
    s.edits += 1
    c.isAfterEdit = true
  }
  if (e.isError || (e.tool === 'Bash' && isHiddenFailure(e.text))) {
    s.errors += 1
    const sig = signatureOf(e.tool, e.text)
    const isRepeat = [...earlier, ...c.failures].includes(sig)
    const isEditFail = e.tool === 'Bash' && c.isAfterEdit
    if (isEditFail) {
      s.editFailLoops += 1
    }
    if (isRepeat && !s.repeated.includes(sig)) {
      s.repeated.push(sig)
    }
    if (isRepeat || (isEditFail && s.editFailLoops >= 2)) {
      s.strong += 1
    }
    c.failures.push(sig)
  }
  if (e.tool === 'Bash') {
    c.isAfterEdit = false
  }
}

/**
 * A turn's own direction. Light needs a small, error-free turn that used at
 * least one tool, all of them read-only: a turn with no tool calls says
 * nothing about how hard the work was (design, review, analysis can run
 * without tools), so it is neither light nor heavy.
 */
export function turnSignal(s: TurnStats): { direction: Direction; reasons: string[] } {
  if (s.strong > 0) {
    return { direction: 'up', reasons: [`강한 실패 신호 ${s.strong}회`] }
  }
  const isOnlyReading = s.readOnly >= s.tools - s.edits
  const isLight = s.tools > 0 && s.errors === 0 && s.edits <= 1 && s.steps <= 4 && isOnlyReading
  if (isLight) {
    return { direction: 'down', reasons: [`가벼운 턴 (${s.steps}단계, 편집 ${s.edits}, 오류 0)`] }
  }

  return { direction: 'keep', reasons: [] }
}

/** A turn of sizeable work: many model requests or many edits. */
const isHeavyTurn = (s: TurnStats): boolean => s.steps >= 10 || s.edits >= 3

/** `light`: the window's light turns, the only evidence for going down. */
export type Reading = { level: number; strong: number; light: number; reasons: string[] }

/**
 * The level the last WINDOW main turns ask for. Failures are facts; the
 * prompt's look (prior) only tips a borderline window: light lets two light
 * turns read light, heavy blocks a light read and with one sizeable turn
 * reads heavy, never very heavy on its own.
 */
export function readLevel(window: readonly TurnStats[], prior: Prior | null): Reading {
  const strong = window.reduce((n, s) => n + s.strong, 0)
  const heavy = window.filter(isHeavyTurn).length
  const light = window.filter(s => turnSignal(s).direction === 'down').length
  const reasons: string[] = []
  if (strong > 0) {
    reasons.push(`최근 ${window.length}턴에 강한 실패 신호 ${strong}회`)
  }
  if (heavy > 0) {
    reasons.push(`큰 작업 턴 ${heavy}회`)
  }
  if (strong >= 3) {
    return { level: 3, strong, light, reasons }
  }
  if (strong >= 1 || heavy >= 2 || (prior === 'heavy' && heavy >= 1)) {
    return { level: 2, strong, light, reasons }
  }
  const lightNeeded = prior === 'light' ? DOWN_AFTER - 1 : DOWN_AFTER
  if (prior !== 'heavy' && window.length >= lightNeeded && light === window.length) {
    return { level: 0, strong, light, reasons: [`가벼운 턴 ${light}회 연속`] }
  }

  return { level: 1, strong, light, reasons: reasons.length > 0 ? reasons : [`최근 ${window.length}턴에 강한 실패 신호·큰 작업 없음`] }
}

export const familyOf = (model: string): Family | null =>
  FAMILIES.find(family => model.toLowerCase().includes(family)) ?? null

/** The level the session's model·effort serves; null for a model or effort off the table. */
export function tierOf(model: string, effort: string): number | null {
  const family = familyOf(model)
  const i = (LADDER as readonly string[]).indexOf(effort)

  return family === null || i < 0 ? null : (TIER[family][i] ?? null)
}

const tierOfCombo = (c: Combo): number => TIER[c.family][LADDER.indexOf(c.effort)] ?? 0

/** Models without the xhigh effort level (code.claude.com/docs/en/model-config). */
const NO_XHIGH = /(?:opus|sonnet)-4-6(?!\d)/i

/**
 * The combos that take the session to `target`: each TARGETS entry as the
 * session's model generation can run it (xhigh tries high, then max, where it
 * does not exist), kept only if it differs from the session's combo, serves
 * the target in TIER, and when going down sits below the session's level.
 */
export function candidates(target: number, model: string, effort: string): Combo[] {
  const current = tierOf(model, effort)
  const family = familyOf(model)
  const out: Combo[] = []
  for (const option of TARGETS[target] ?? []) {
    const efforts: Combo['effort'][] = option.effort === 'xhigh' && NO_XHIGH.test(model) ? ['high', 'max'] : [option.effort]
    for (const e of efforts) {
      const combo: Combo = { family: option.family, effort: e }
      const tier = tierOfCombo(combo)
      const isCurrent = combo.family === family && combo.effort === effort
      const serves = tier >= target && (current === null || target > current || tier < current)
      const isDuplicate = out.some(c => c.family === combo.family && c.effort === combo.effort)
      if (!isCurrent && serves && !isDuplicate) {
        out.push(combo)
        break
      }
    }
  }

  return out
}

/**
 * fit: the session's combo serves the level read. change: options take it
 * to `target`. observing: a step down was read but is held back. unsupported:
 * the combo is not in TIER. no-option: a change is due but nothing passes.
 */
export type Judgment = {
  status: Status
  /** The level the session's combo serves; null when unsupported. */
  current: number | null
  /** The level a change aims at, or a held step down would; null when fit or unsupported. */
  target: number | null
  options: Combo[]
  /** The target stops short of the level read, the evidence being weak. */
  isStepLimited: boolean
  reason: string
}

/**
 * What the panel says. Going up: straight to the level read when two strong
 * events back it, else one step. Going down is held (observing) while the
 * prompt is classified heavy or the window holds fewer than DOWN_AFTER light
 * turns: turns without tools or with long read-only digging are no evidence
 * the work is easy. It goes more than one step only on WINDOW light turns.
 */
export function judge(model: string, effort: string, reading: Reading, prior: Prior | null): Judgment {
  const current = tierOf(model, effort)
  const none = { options: [], isStepLimited: false }
  if (current === null) {
    const reason = effort === '-' ? 'effort를 쓰지 않는 모델' : '판정표에 없는 모델·effort'
    return { status: 'unsupported', current: null, target: null, ...none, reason }
  }
  const { level, strong, light } = reading
  if (level === current) {
    return { status: 'fit', current, target: null, ...none, reason: '' }
  }
  if (level < current) {
    const step = current - level >= 2 && light < WINDOW ? current - 1 : level
    if (prior === 'heavy') {
      return { status: 'observing', current, target: step, ...none, reason: '로컬 분류가 heavy라 낮추지 않음' }
    }
    if (light < DOWN_AFTER) {
      return { status: 'observing', current, target: step, ...none, reason: `가벼운 턴이 ${light}개뿐이라 근거 부족 (${DOWN_AFTER}개부터 판단)` }
    }
  }
  const isSure = level > current ? strong >= 2 : light >= WINDOW
  const target = Math.abs(level - current) >= 2 && !isSure ? current + Math.sign(level - current) : level
  const options = candidates(target, model, effort)
  if (options.length === 0) {
    return { status: 'no-option', current, target, ...none, reason: `${LEVEL_NAMES[target]} 수준을 채우는 다른 조합이 표에 없음` }
  }

  return { status: 'change', current, target, options, isStepLimited: target !== level, reason: '' }
}

export const STATUS_NAMES: Record<Status, string> = {
  fit: '적합',
  change: '변경 권장',
  observing: '추가 관찰 중',
  unsupported: '지원하지 않는 조합',
  'no-option': '권장할 조합 없음',
}

const STATUS_MARK: Record<FitView['status'], string> = {
  fit: '●',
  change: '',
  observing: '◌',
  unsupported: '·',
  'no-option': '·',
}

/** The status line: the session's combo, the verdict, and the detected level the panel shows too. */
export function statusLine(v: FitView): string {
  const head = `${shortModel(v.model)}·${v.effort}`
  const detected = `(감지 ${LEVEL_NAMES[v.level] ?? ''})`
  const first = v.options[0]
  if (v.status === 'change' && first !== undefined) {
    const arrow = (v.target ?? 0) > (v.current ?? 0) ? '▲' : '▼'
    return `${head} ${arrow} ${comboLabel(first)} 권장 ${detected}`
  }

  return `${head} ${STATUS_MARK[v.status]} ${STATUS_NAMES[v.status]} ${detected}`
}

/** The panel's verdict line after the session's combo. */
export function verdictText(j: Judgment, level: number): string {
  const name = (l: number | null) => (l === null ? '' : (LEVEL_NAMES[l] ?? ''))
  if (j.status === 'change') {
    const limited = j.isStepLimited ? ` (감지 수준은 ${name(level)}이지만 근거가 약해 한 단계만)` : ''
    return `${STATUS_NAMES.change} → ${name(j.target)} 수준${limited}`
  }
  if (j.status === 'observing') {
    return `${STATUS_NAMES.observing} — ${name(j.target)} 수준으로 낮출 후보지만 ${j.reason}`
  }

  return j.reason === '' ? STATUS_NAMES[j.status] : `${STATUS_NAMES[j.status]} — ${j.reason}`
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

/**
 * What taking an option costs in cache, as far as code.claude.com/docs/en/prompt-caching
 * vouches: a model switch makes the next request read the whole conversation
 * with no cache hits; an effort change on a model that keeps the cache costs
 * nothing extra. `contextTokens` is the last response's input tokens
 * ($.session.usage().context.tokens), only an estimate of what is re-read.
 */
export function cacheNote(option: { isModelSwitch: boolean; keepsCache: boolean }, contextTokens: number | null): string {
  if (option.keepsCache) {
    return 'effort만 변경 · 캐시 유지 (공식 문서 기준)'
  }
  const kind = option.isModelSwitch ? '모델 전환' : 'effort 변경'
  if (contextTokens === null) {
    return `${kind} · 대화 전체를 캐시 없이 다시 처리 (양은 알 수 없음)`
  }

  return `${kind} · 대화 전체 약 ${Math.round(contextTokens / 1000)}k 토큰을 캐시 없이 다시 처리 (마지막 응답의 입력 토큰으로 추정)`
}

/**
 * Right after compaction the conversation is a short summary, so a
 * cache-breaking change re-reads the least it can; the docs promise no more.
 */
export const compactionToast = (label: string): string =>
  `compaction 직후입니다. 대화가 요약으로 짧아져 지금 ${label}(으)로 바꾸면 캐시 없이 다시 처리하는 양이 가장 적습니다.`

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

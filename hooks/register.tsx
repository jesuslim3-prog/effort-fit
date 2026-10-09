import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentFit, Direction, FitView, Prior } from '../types'
import {
  EDIT_TOOLS,
  IGNORED_TOOLS,
  advance,
  decide,
  emptyStats,
  holdUp,
  isEnvOn,
  isNotificationPrompt,
  keepsCache,
  notificationTracker,
  parsePrior,
  shortModel,
  signatureOf,
  suggest,
  turnSignal,
  usageCounts,
  type Streak,
  type TurnStats,
  type UpHold,
} from './judge'

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate'
const OLLAMA_MODEL = 'qwen3.8:27b'
const CLASSIFY_PROMPT =
  'Classify how much reasoning a coding agent needs for this request. ' +
  'light = mechanical edits, lookups, bookkeeping. normal = ordinary implementation or explanation. ' +
  'heavy = debugging repeated failures, design across many files, subtle correctness. Answer JSON only.\nRequest:\n'
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: { level: { type: 'string', enum: ['light', 'normal', 'heavy'] } },
  required: ['level'],
}
/** Main-thread turns whose failures count toward "repeated". */
const FAILURE_WINDOW = 3
const LOG_LIMIT = 300
const ARROW: Record<Direction, string> = { keep: '●', up: '▲', down: '▼' }

const view = atom({ plugin: 'effort-fit', key: 'view' } as const, null)
const agents = atom({ plugin: 'effort-fit', key: 'agents' } as const, [])
const isHidden = atom({ plugin: 'effort-fit', key: 'isHidden' } as const, false)

type Loop = {
  type: string
  model: string
  effort: string
  stats: TurnStats
  failures: string[]
  isAfterEdit: boolean
}

const newLoop = (): Loop => ({
  type: '?',
  model: '',
  effort: '-',
  stats: emptyStats(),
  failures: [],
  isAfterEdit: false,
})

async function classify($: EngineInterface, text: string): Promise<Prior | null> {
  try {
    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: CLASSIFY_PROMPT + text.slice(0, 2000),
      stream: false,
      think: false,
      format: CLASSIFY_SCHEMA,
      keep_alive: '30m',
      options: { temperature: 0 },
    })
    const res = await $.http.fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })

    return res.ok ? parsePrior(res.text) : null
  } catch {
    // Ollama down or slow: the meter runs on its deterministic signals alone.
    return null
  }
}

/**
 * Whether changing effort starts a fresh cache here on any model: a
 * third-party provider, or the betas stripped. A gateway or a HIPAA
 * configuration cannot be told from here.
 */
async function isEffortCacheBroken($: EngineInterface): Promise<boolean> {
  const values = await Promise.all([
    $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    $.env.get('CLAUDE_CODE_USE_MANTLE'),
    $.env.get('CLAUDE_CODE_USE_VERTEX'),
    $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'),
  ])

  return values.some(isEnvOn)
}

function statusText(v: FitView): string {
  const head = `${shortModel(v.model)}·${v.effort}`
  if (v.direction === 'keep' || v.suggestion === null) {
    return `${head} ● 유지`
  }

  return v.direction === 'up' ? `${head} ▲ ${v.suggestion} 권장` : `${head} ▼ ${v.suggestion} 가능`
}

export const register: Register = on => {
  const main = newLoop()
  const loops = new Map<string, Loop>()
  /** Failure signatures of the last FAILURE_WINDOW main turns, oldest first. */
  let mainHistory: string[][] = []
  let streak: Streak = { direction: 'keep', count: 0 }
  let upHold: UpHold | null = null
  let promptSeq = 0
  let prior: { seq: number; level: Prior } | null = null
  const notifications = notificationTracker()

  const loopOf = (agentId: string | undefined): Loop => {
    if (agentId === undefined) {
      return main
    }
    let loop = loops.get(agentId)
    if (loop === undefined) {
      loop = newLoop()
      loops.set(agentId, loop)
    }

    return loop
  }

  on('prompt.submit', ($, e, next) => {
    promptSeq += 1
    const seq = promptSeq
    const text = e.text.trim()
    notifications.submitted(e.origin.kind, text)
    if (text !== '' && !text.startsWith('/') && !isNotificationPrompt(e.origin.kind, text)) {
      $.clock.after(1, () => {
        void classify($, text).then(level => {
          if (level !== null && seq === promptSeq) {
            prior = { seq, level }
          }
        })
      })
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    const agentId = ran.agentId
    if (agentId !== undefined) {
      loopOf(agentId).type = e.subagentType
      await update($, agents, list =>
        list.map(row => (row.agentId === agentId ? { ...row, type: e.subagentType } : row)),
      )
    }

    return ran
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.index === 0) {
      notifications.turnStarted()
    }
    const loop = loopOf(e.agentId)
    loop.model = e.model
    loop.effort = e.effort === undefined ? '-' : String(e.effort)
    loop.stats.steps += 1

    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (ran.deny !== undefined || IGNORED_TOOLS.includes(e.tool)) {
        return ran
      }
      const loop = loopOf(e.agentId)
      const s = loop.stats
      s.tools += 1
      if (ran.isReadOnly === true) {
        s.readOnly += 1
      }
      if (EDIT_TOOLS.includes(e.tool)) {
        s.edits += 1
        loop.isAfterEdit = true
      }
      if (ran.isError === true) {
        s.errors += 1
        const sig = signatureOf(e.tool, 'text' in ran ? ran.text : undefined)
        const earlier = e.agentId === undefined ? mainHistory.flat() : []
        if ([...earlier, ...loop.failures].includes(sig) && !s.repeated.includes(sig)) {
          s.repeated.push(sig)
        }
        loop.failures.push(sig)
        if (e.tool === 'Bash' && loop.isAfterEdit) {
          s.editFailLoops += 1
        }
      }
      if (e.tool === 'Bash') {
        loop.isAfterEdit = false
      }
    } catch {
      // Bookkeeping only; the call's result stands either way.
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const loop = loops.get(e.agentId)
      loops.delete(e.agentId)
      if (loop !== undefined && !e.isAborted) {
        const signal = turnSignal(loop.stats)
        const row: AgentFit = {
          agentId: e.agentId,
          type: loop.type,
          model: loop.model,
          effort: loop.effort,
          direction: signal.direction,
          reason: signal.reasons.join(', '),
        }
        await update($, agents, list => [row, ...list.filter(r => r.agentId !== row.agentId)].slice(0, 4))
      }
      const agentLog = ((await $.store.get('agentLog')) ?? []) as unknown[]
      const agentEntry = {
        at: await $.clock.now(),
        sessionId: await $.session.id(),
        turnId: e.turnId,
        durationMs: e.durationMs,
        agentId: e.agentId,
        isTracked: loop !== undefined,
        isAborted: e.isAborted,
        type: loop?.type ?? '?',
        model: loop?.model ?? '',
        effort: loop?.effort ?? '-',
        ...(loop === undefined ? {} : { ...loop.stats, repeated: loop.stats.repeated.length }),
        ...usageCounts(e.usage),
      }
      await $.store.set('agentLog', [...agentLog, agentEntry].slice(-LOG_LIMIT))

      return next(e)
    }

    const stats = main.stats
    const failures = main.failures
    main.stats = emptyStats()
    main.failures = []
    main.isAfterEdit = false
    if (e.isAborted || stats.steps === 0 || notifications.isNotificationTurn()) {
      return next(e)
    }
    mainHistory = [...mainHistory, failures].slice(-(FAILURE_WINDOW - 1))

    const signal = turnSignal(stats)
    streak = advance(streak, signal.direction)
    const turnPrior = prior !== null && prior.seq === promptSeq ? prior.level : null
    const decided = decide(streak, turnPrior)
    const held = holdUp(decided, upHold, `${main.model}|${main.effort}`)
    upHold = held.hold
    const direction = held.shown
    const before = await read($, view)
    const isHeldOver = direction === 'up' && decided !== 'up' && before !== null
    const suggestion = isHeldOver ? before.suggestion : suggest(direction, main.model, main.effort)
    const next_: FitView = {
      model: main.model,
      effort: main.effort,
      direction,
      suggestion,
      keepsCache: suggestion !== null && keepsCache(suggestion, main.model, await isEffortCacheBroken($)),
      reasons: direction === 'keep' ? [] : isHeldOver ? before.reasons : signal.reasons,
      prior: isHeldOver ? before.prior : turnPrior,
    }
    await update($, view, () => next_)
    if (before?.direction !== direction) {
      await update($, isHidden, () => false)
    }
    $.ui.status(statusText(next_))

    const entry = {
      at: await $.clock.now(),
      sessionId: await $.session.id(),
      turnId: e.turnId,
      durationMs: e.durationMs,
      model: main.model,
      effort: main.effort,
      signal: signal.direction,
      shown: direction,
      prior: turnPrior,
      ...stats,
      repeated: stats.repeated.length,
      ...usageCounts(e.usage),
    }
    const log = ((await $.store.get('log')) ?? []) as unknown[]
    await $.store.set('log', [...log, entry].slice(-LOG_LIMIT))

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const ran = await next(e)
    const v = await read($, view)
    const isToasted =
      e.agentId === undefined &&
      e.trigger !== 'precompute' &&
      ran.skip === undefined &&
      v !== null &&
      v.direction !== 'keep' &&
      v.suggestion !== null &&
      !v.keepsCache
    if (isToasted) {
      $.ui.toast(`compaction 직후입니다. 지금 ${v.suggestion}(으)로 바꾸면 캐시 손실 없이 적용됩니다.`)
    }
    const compactLog = ((await $.store.get('compactLog')) ?? []) as unknown[]
    const compactEntry = {
      at: await $.clock.now(),
      sessionId: await $.session.id(),
      trigger: e.trigger,
      agentId: e.agentId ?? null,
      skip: ran.skip ?? null,
      direction: v?.direction ?? null,
      isToasted,
    }
    await $.store.set('compactLog', [...compactLog, compactEntry].slice(-LOG_LIMIT))

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const rows = (await read($, agents)).filter(r => r.direction !== 'keep')
    const hasMain = v !== null && v.direction !== 'keep' && v.suggestion !== null
    if (e.props.hasSurvey || (await read($, isHidden)) || (!hasMain && rows.length === 0)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {hasMain && v !== null ? (
          <Text wrap="wrap">
            {ARROW[v.direction]} {v.suggestion} {v.direction === 'up' ? '권장' : '가능'}: {v.reasons.join(', ')}
            {v.prior === null ? '' : ` · 분류 ${v.prior}`}
          </Text>
        ) : null}
        {hasMain && v !== null ? (
          <Text dimColor wrap="wrap">
            {v.keepsCache
              ? '이 모델에서는 effort를 바꿔도 프롬프트 캐시가 유지되니 지금 바꿔도 됩니다.'
              : '적용은 다음 compaction 직후나 새 세션에서 하세요. 대화 중간 전환은 컨텍스트 전체를 캐시 없이 다시 처리합니다.'}
          </Text>
        ) : null}
        {rows.map(r => (
          <Text key={r.agentId} wrap="wrap">
            {ARROW[r.direction]} 서브에이전트 {r.type} {shortModel(r.model)}·{r.effort}: {r.reason} (에이전트 정의에서 조정)
          </Text>
        ))}
        <Button key="hide" label="숨기기" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}

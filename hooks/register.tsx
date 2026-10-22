import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentFit, Direction, FitView } from '../types'
import {
  LEVEL_NAMES,
  WINDOW,
  cacheNote,
  comboLabel,
  compactionToast,
  familyOf,
  fromToolCall,
  isEnvOn,
  isNotificationPrompt,
  judge,
  keepsCache,
  newCollector,
  notificationTracker,
  readLevel,
  recordTool,
  shortModel,
  statusLine,
  turnSignal,
  usageCounts,
  verdictText,
  type Collector,
  type TurnStats,
} from './judge'

/** Main-thread turns whose failures count toward "repeated". */
const FAILURE_WINDOW = 3
const LOG_LIMIT = 300
const ARROW: Record<Direction, string> = { keep: '●', up: '▲', down: '▼' }

const view = atom({ plugin: 'effort-fit', key: 'judgment' } as const, null)
const agents = atom({ plugin: 'effort-fit', key: 'agents' } as const, [])
const isHidden = atom({ plugin: 'effort-fit', key: 'isHidden' } as const, false)

type Loop = {
  type: string
  model: string
  effort: string
  c: Collector
}

const newLoop = (): Loop => ({ type: '?', model: '', effort: '-', c: newCollector() })

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

const levelBar = (level: number): string => '■'.repeat(level + 1) + '□'.repeat(3 - level)

/** What a hidden panel waits on: it shows again once the verdict or the recommendation changes. */
const recommendationKey = (v: FitView | null): string =>
  v === null ? '' : `${v.status}|${v.options[0] === undefined ? '' : comboLabel(v.options[0])}`

export const register: Register = on => {
  const main = newLoop()
  const loops = new Map<string, Loop>()
  /** Failure signatures of the last FAILURE_WINDOW main turns, oldest first. */
  let mainHistory: string[][] = []
  /** The last WINDOW judged main turns, oldest first. */
  let recent: TurnStats[] = []
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
    const text = e.text.trim()
    notifications.submitted(e.origin.kind, text)
    if (isNotificationPrompt(e.origin.kind, text)) {
      return next(e)
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
    loop.c.stats.steps += 1

    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const earlier = e.agentId === undefined ? mainHistory.flat() : []
      recordTool(loopOf(e.agentId).c, fromToolCall(e.tool, ran), earlier)
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
        const signal = turnSignal(loop.c.stats)
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
        ...(loop === undefined ? {} : { ...loop.c.stats, repeated: loop.c.stats.repeated.length }),
        ...usageCounts(e.usage),
      }
      await $.store.set('agentLog', [...agentLog, agentEntry].slice(-LOG_LIMIT))

      return next(e)
    }

    const { stats, failures } = main.c
    main.c = newCollector()
    if (e.isAborted || stats.steps === 0 || notifications.isNotificationTurn()) {
      return next(e)
    }
    mainHistory = [...mainHistory, failures].slice(-(FAILURE_WINDOW - 1))

    const signal = turnSignal(stats)
    recent = [...recent, stats].slice(-WINDOW)
    const reading = readLevel(recent)
    const j = judge(main.model, main.effort, reading)
    const isBroken = await isEffortCacheBroken($)
    const next_: FitView = {
      model: main.model,
      effort: main.effort,
      level: reading.level,
      current: j.current,
      target: j.target,
      status: j.status,
      statusReason: j.reason,
      isStepLimited: j.isStepLimited,
      options: j.options.map(combo => ({
        ...combo,
        isModelSwitch: familyOf(main.model) !== combo.family,
        keepsCache: keepsCache(combo, main.model, isBroken),
      })),
      reasons: reading.reasons,
      contextTokens: (await $.session.usage()).context.tokens ?? null,
    }
    const before = await read($, view)
    await update($, view, () => next_)
    if (recommendationKey(before) !== recommendationKey(next_)) {
      await update($, isHidden, () => false)
    }
    $.ui.status(statusLine(next_))

    const entry = {
      at: await $.clock.now(),
      sessionId: await $.session.id(),
      turnId: e.turnId,
      durationMs: e.durationMs,
      model: main.model,
      effort: main.effort,
      signal: signal.direction,
      level: reading.level,
      current: next_.current,
      target: next_.target,
      status: next_.status,
      recommended: next_.options[0] === undefined ? null : comboLabel(next_.options[0]),
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
    const first = v?.options[0]
    const isToasted =
      e.agentId === undefined &&
      e.trigger !== 'precompute' &&
      ran.skip === undefined &&
      first !== undefined &&
      !first.keepsCache
    if (isToasted) {
      $.ui.toast(compactionToast(comboLabel(first)))
    }
    const compactLog = ((await $.store.get('compactLog')) ?? []) as unknown[]
    const compactEntry = {
      at: await $.clock.now(),
      sessionId: await $.session.id(),
      trigger: e.trigger,
      agentId: e.agentId ?? null,
      skip: ran.skip ?? null,
      recommended: first === undefined ? null : comboLabel(first),
      isToasted,
    }
    await $.store.set('compactLog', [...compactLog, compactEntry].slice(-LOG_LIMIT))

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const rows = (await read($, agents)).filter(r => r.direction !== 'keep')
    if (e.props.hasSurvey || (await read($, isHidden)) || (v === null && rows.length === 0)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {v !== null ? (
          <Text wrap="wrap">
            감지한 요구 수준 {levelBar(v.level)} {LEVEL_NAMES[v.level]} · {v.reasons.join(', ')}
          </Text>
        ) : null}
        {v !== null ? (
          <Text wrap="wrap">
            지금 {shortModel(v.model)}·{v.effort}
            {v.current === null ? '' : ` (${LEVEL_NAMES[v.current]} 수준)`}:{' '}
            {verdictText({ ...v, reason: v.statusReason }, v.level)}
          </Text>
        ) : null}
        {v?.options.map((o, k) => (
          <Text key={comboLabel(o)} wrap="wrap">
            {k === 0 ? '추천' : '대안'} {comboLabel(o)} · {cacheNote(o, v.contextTokens)}
          </Text>
        ))}
        {v !== null && v.options.some(o => !o.keepsCache) ? (
          <Text dimColor wrap="wrap">
            캐시가 깨지는 변경은 compaction 직후에 하면 캐시 없이 다시 처리하는 양이 가장 적습니다. 그래도 그 양이 0이 되지는 않습니다.
          </Text>
        ) : null}
        {rows.map(r => (
          <Text key={r.agentId} wrap="wrap">
            {ARROW[r.direction]} 서브에이전트 {r.type} {shortModel(r.model)}·{r.effort}: {r.reason}
          </Text>
        ))}
        <Button key="hide" label="숨기기" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}

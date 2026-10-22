export type Direction = 'keep' | 'up' | 'down'

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type Combo = { family: Family; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }

export type FitOption = Combo & {
  /** Whether getting there switches the model. */
  isModelSwitch: boolean
  /** Whether moving there now keeps the prompt cache. */
  keepsCache: boolean
}

/** See `judge()` in hooks/judge.ts. */
export type Status = 'fit' | 'change' | 'observing' | 'unsupported' | 'no-option'

export type FitView = {
  model: string
  effort: string
  /** The level detected from the recent work, 0 (light) to 3 (very heavy); the panel and the status line both show this one. */
  level: number
  /** The level the session's model·effort serves; null when unsupported. */
  current: number | null
  /** The level a change aims at, or a held step down would; null when fit or unsupported. */
  target: number | null
  status: Status
  /** Why observing, unsupported or no-option. */
  statusReason: string
  /** The target stops one step short of `level`, the evidence being weak. */
  isStepLimited: boolean
  /** The recommendation, then the alternative; only when status is change. */
  options: FitOption[]
  reasons: string[]
  /** Input tokens of the last response ($.session.usage().context.tokens): an estimate of what a cache-breaking change re-reads. */
  contextTokens: number | null
}

export type AgentFit = {
  agentId: string
  type: string
  model: string
  effort: string
  direction: Direction
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    'effort-fit': { judgment: FitView | null; agents: AgentFit[]; isHidden: boolean }
  }
}

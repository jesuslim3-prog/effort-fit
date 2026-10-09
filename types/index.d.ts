export type Direction = 'keep' | 'up' | 'down'

/** The local classifier's read of the prompt; a hint, never a trigger on its own. */
export type Prior = 'light' | 'normal' | 'heavy'

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type Combo = { family: Family; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }

export type FitOption = Combo & {
  /** Whether getting there switches the model. */
  isModelSwitch: boolean
  /** Whether moving there now keeps the prompt cache. */
  keepsCache: boolean
}

export type FitView = {
  model: string
  effort: string
  /** The level the recent work asks for, 0 (light) to 3 (very heavy). */
  level: number
  /** The level recommended, which may stop one step short of `level`; null when the session already sits right. */
  target: number | null
  /** The recommendation, then the alternative; empty when there is none. */
  options: FitOption[]
  reasons: string[]
  prior: Prior | null
  /** Input tokens of the last response: what a cache-breaking change re-reads. */
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
    'effort-fit': { panel: FitView | null; agents: AgentFit[]; isHidden: boolean }
  }
}

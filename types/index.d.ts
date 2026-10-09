export type Direction = 'keep' | 'up' | 'down'

/** The local classifier's read of the prompt; a hint, never a trigger on its own. */
export type Prior = 'light' | 'normal' | 'heavy'

export type FitView = {
  model: string
  effort: string
  direction: Direction
  /** What to change to, e.g. "effort xhigh"; null when there is nothing to change to. */
  suggestion: string | null
  /** Whether taking the suggestion now keeps the prompt cache. */
  keepsCache: boolean
  reasons: string[]
  prior: Prior | null
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
    'effort-fit': { view: FitView | null; agents: AgentFit[]; isHidden: boolean }
  }
}

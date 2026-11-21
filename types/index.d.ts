export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Snap = { tokens?: number; window: number; limits: Limit[] }

declare module 'claude-code' {
  interface PluginState {
    'token-diet': {
      snap: Snap | null
      notes: string[]
      ctxStep: number
      softFired: string[]
    }
  }
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Snap = { tokens?: number; window: number; limits: Limit[] }
/** This session's handoff file, and the context size (tokens) when it was last written; 0 if only read. */
export type Handoff = { path: string; at: number }
/** One reading of the 5-hour window: time (ms), percent used, and the window's reset time. */
export type Sample = { t: number; p: number; r: string }
/** Minutes until the hard limit at the measured burn rate, and when that was computed (ms). */
export type Eta = { minutes: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    'token-diet': {
      snap: Snap | null
      notes: string[]
      ctxStep: number
      softFired: string[]
      handoff: Handoff | null
      samples: Sample[]
      eta: Eta | null
      /** This session's 8-hex tag, used in its handoff file name; '' until first needed. */
      sid: string
      /** Tokens used since the last usage-log line, per model: input, output, cache read, 5m write, 1h write. */
      spent: Record<string, number[]>
      /** This session's usage-log file; '' until its first line. */
      logPath: string
      /** The window readings of the last usage-log line, to skip a line with no news. */
      logged: string
    }
  }
}

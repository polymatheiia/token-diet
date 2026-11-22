import type { Register, SessionMessage } from 'claude-code'

/** Tool results longer than this (chars) are replaced by a stub. */
const MIN_CHARS = 2000
/** The newest messages are left as they are. */
const KEEP_LAST = 2

export const register: Register = on => {
  on('session.compact', async ($, e) => {
    const cut = e.messages.length - KEEP_LAST
    let rebuilt = 0
    let dropped = 0

    const messages = e.messages.map((m, i): SessionMessage => {
      const isLarge = m.toolResults?.some(r => r.text.length > MIN_CHARS) === true
      if (i >= cut || m.role !== 'user' || !isLarge) return m // kept by handle: the engine's own, whole

      rebuilt++
      // No handle: the engine builds this message from role, text and tool blocks.
      return {
        role: 'user',
        text: m.text,
        toolUses: [],
        toolResults: (m.toolResults ?? []).map(r => {
          if (r.text.length <= MIN_CHARS) return { tool_use_id: r.tool_use_id, isError: r.isError, text: r.text }
          dropped += r.text.length
          return {
            tool_use_id: r.tool_use_id,
            isError: r.isError,
            text: `[pruned: ${r.text.length} chars of tool output; run the call again if it is needed]`,
          }
        }),
      }
    })

    const shape = e.messages.map(m => `${m.role[0]}${m.handle ? 'h' : '-'}${m.toolUses.length}/${m.toolResults?.length ?? 0}:${m.text.length}`)
    await $.fs.write('prune-spike.log', `${JSON.stringify({ trigger: e.trigger, count: e.messages.length, rebuilt, dropped, shape })}\n`)

    if (rebuilt === 0) return { skip: 'prune-spike: no tool result is large enough' }
    return { messages }
  })
}

import type { UsageUnit } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const measure = (tokens: number, fiveHour: number, weekly = 10) => ({
  context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-11-21T16:40:00Z' },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: '2026-11-25T08:00:00Z' },
  ],
  changed: ['context', 'rateLimits'] as UsageUnit[],
})

test('at the hard limit only the handoff file can be written', async ($, on) => {
  const ran: string[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_, e) => (ran.push(e.tool), { result: {} }))

  await $.session.measure(measure(50_000, 96))

  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(bash.isError === true || bash.deny !== undefined).toBe(true)

  await $.tool.call({ tool: 'Write', file_path: '/repo/HANDOFF.md', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/handoff/2026-11-21.md', content: 'x' })
  expect(ran).toEqual(['Write', 'Write'])
})

test('general subagents are moved to sonnet unless the prompt names opus', async ($, on) => {
  const models: (string | undefined)[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent') models.push(e.model)
    return { result: {} }
  })

  await $.prompt.submit(typed('build the lanes'))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', model: 'opus' })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'web-fetch' })

  await $.prompt.submit(typed('review this with opus please'))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', model: 'opus' })

  expect(models).toEqual(['sonnet', 'sonnet', undefined, 'opus'])
})

test('crossing the context threshold queues one note, delivered once', async ($, on) => {
  const contexts: (readonly string[] | undefined)[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => (contexts.push(e.context), { text: e.text, context: e.context }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(160_000, 20))
  await $.session.measure(measure(170_000, 20))

  await $.prompt.submit(typed('next'))
  await $.prompt.submit(typed('again'))

  expect(contexts[0]?.length).toBe(1)
  expect(contexts[0]?.[0]).toContain('160k')
  expect(contexts[1] ?? []).toEqual([])
})

test('the soft limit note arrives mid-turn on a tool result', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(20_000, 81))
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect('context' in first ? first.context?.[0] : '').toContain('5h usage is at 81%')
  expect('context' in second ? second.context ?? [] : []).toEqual([])
})

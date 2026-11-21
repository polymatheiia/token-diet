import type { UsageUnit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const T0 = Date.parse('2026-11-21T12:00:00Z')
const MIN = 60_000
const why = (r: object) => String((r as { deny?: string; text?: string }).deny ?? (r as { text?: string }).text ?? '')
const notes = (r: object) => ((r as { context?: readonly string[] }).context ?? []).join('\n')

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
  mock.clock(on, { now: T0 })
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
  mock.clock(on, { now: T0 })
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
  mock.clock(on, { now: T0 })
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
  mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(20_000, 81))
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect('context' in first ? first.context?.[0] : '').toContain('5h usage is at 81%')
  expect('context' in second ? second.context ?? [] : []).toEqual([])
})

test('a hard-limit reading whose window has reset no longer blocks', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(50_000, 96))
  expect(why(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('token-diet')

  await clock.set(Date.parse('2026-11-21T16:41:00Z'))
  expect(why(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
})

test('at the hard limit a subagent is told to stop, not to write the handoff', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(50_000, 96))
  const sub = why(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' }))
  expect(sub).toContain('Stop')
  expect(sub).not.toContain('write it')
  expect(why(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('write it')
})

test('an explicit strong model is downgraded with a note; a negated mention is no opt-in', async ($, on) => {
  const models: (string | undefined)[] = []
  mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent') models.push(e.model)
    return { result: {} }
  })

  await $.prompt.submit(typed("run the branch review, don't use opus"))
  const explicit = await $.tool.call({ tool: 'Agent', description: 'Branch review', prompt: 'p', model: 'fable' })
  const plain = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' })

  await $.prompt.submit(typed('no opus or fable for the lanes'))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', model: 'opus' })
  await $.prompt.submit(typed('use opus for the review, not fable'))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', model: 'opus' })

  expect(models).toEqual(['sonnet', 'sonnet', 'sonnet', 'opus'])
  expect(notes(explicit)).toContain('ran on sonnet, not fable')
  expect(notes(explicit)).toContain('Do not retry')
  expect(notes(plain)).toBe('')
})

test('keepStrongFor leaves matching agents on the model they asked for', { options: { keepStrongFor: 'security, branch review' } }, async ($, on) => {
  const models: (string | undefined)[] = []
  mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent') models.push(e.model)
    return { result: {} }
  })

  await $.tool.call({ tool: 'Agent', description: 'Branch review of #12', prompt: 'p', model: 'fable' })
  await $.tool.call({ tool: 'Agent', description: 'Fix lane', prompt: 'p', model: 'opus' })
  expect(models).toEqual(['fable', 'sonnet'])
})

test('past the spawn gate the main loop cannot start agents until the handoff is written', async ($, on) => {
  const ran: string[] = []
  mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_, e) => (ran.push(e.tool), { result: {} }))

  await $.session.measure(measure(310_000, 20))
  const gated = why(await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' }))
  expect(gated).toContain('HANDOFF.md')
  expect(gated).toContain('Write or Edit')

  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', agentId: 'a1' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/HANDOFF.md', content: 'x' })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' })
  expect(ran).toEqual(['Agent', 'Write', 'Agent'])

  await $.session.measure(measure(470_000, 20))
  expect(why(await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' }))).toContain('HANDOFF.md')
})

test('spawnGateTokens 0 turns the gate off', { options: { spawnGateTokens: 0 } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(610_000, 20))
  expect(why(await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' }))).toBe('')
})

test('a fast burn warns before the soft limit, and the soft limit still fires later', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(20_000, 50))
  expect(notes(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')

  await clock.advance(4 * MIN)
  await $.session.measure(measure(20_000, 70))
  const early = notes(await $.tool.call({ tool: 'Bash', command: 'ls' }))
  expect(early).toContain('5h usage is at 70%')
  expect(early).toContain('about 5 min')

  await clock.advance(1 * MIN)
  await $.session.measure(measure(20_000, 81))
  expect(notes(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('5h usage is at 81%')
})

test('with a handoffs folder each session gets its own file, and other files there do not count', async ($, on) => {
  const ran: string[] = []
  mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('fs.exists', (_, e) => ({ value: /(^|\/)handoffs$/.test(e.path) }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_, e) => (ran.push(e.tool), { result: {} }))

  await $.session.measure(measure(310_000, 20))
  const gated = why(await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' }))
  const tag = /handoffs\/2026-11-21-<topic>-([0-9a-f]{8})\.md/.exec(gated)?.[1] ?? 'none'
  expect(tag).not.toBe('none')

  await $.tool.call({ tool: 'Write', file_path: '/p/handoffs/api-spec.md', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/p/handoffs/2026-11-21-other-0a1b2c3e.md', content: 'x' })
  expect(why(await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' }))).toContain(tag)

  const mine = `/p/handoffs/2026-11-21-gate-${tag}.md`
  await $.tool.call({ tool: 'Write', file_path: mine, content: 'x' })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' })
  expect(ran).toEqual(['Write', 'Write', 'Write', 'Agent'])

  // Later notes name the exact file this session wrote.
  await $.session.measure(measure(470_000, 20))
  expect(why(await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' }))).toContain(mine)
})

test('a resumed handoff becomes the file of this session, and the skill is told the path', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('fs.exists', (_, e) => ({ value: /(^|\/)handoffs$/.test(e.path) }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('skill.prompt', (_, e) => ({ text: e.text }))

  // Reading a peer's handoff outside the handoff skill adopts nothing.
  await $.tool.call({ tool: 'Read', file_path: '/p/handoffs/2026-11-20-peer-9f8e7d6c.md' })

  const fresh = await $.skill.prompt({ skill: 'token-diet:handoff', text: 'body', frontmatter: {}, source: 'plugin', pluginName: 'token-diet' })
  expect(fresh.text).toMatch(/handoff file: handoffs\/2026-11-21-<topic>-[0-9a-f]{8}\.md/)

  const theirs = '/p/handoffs/2026-11-20-billing-0a1b2c3e.md'
  await $.tool.call({ tool: 'Read', file_path: theirs })
  const resumed = await $.skill.prompt({ skill: 'token-diet:handoff', text: 'body', frontmatter: {}, source: 'plugin', pluginName: 'token-diet' })
  expect(resumed.text).toContain(`handoff file: ${theirs}`)

  const other = await $.skill.prompt({ skill: 'commit', text: 'body', frontmatter: {}, source: 'plugin', pluginName: 'other' })
  expect(other.text).toBe('body')
})

test('the band draws on terminal and desktop: projection while fresh, no window that has reset', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  const band = { plugin: 'token-diet', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

  await $.session.measure(measure(230_000, 50))
  await clock.advance(4 * MIN)
  await $.session.measure(measure(230_000, 62))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band, surface })
    expect(await ui.find({ type: 'Text', text: /ctx 230k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 62%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /95% in 11m/ })).toBeDefined()
    await ui.unmount()
  }

  await clock.set(Date.parse('2026-11-21T16:41:00Z'))
  const later = await $.ui.mount({ ...band, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: /ctx 230k/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /wk 10%/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /5h/ })).toBeUndefined()
  expect(await later.find({ type: 'Text', text: /95% in/ })).toBeUndefined()
  await later.unmount()
})

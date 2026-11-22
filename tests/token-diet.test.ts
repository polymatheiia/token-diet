import type { UsageUnit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const T0 = Date.parse('2026-11-21T12:00:00Z')
const MIN = 60_000
const why = (r: object) => String((r as { deny?: string; text?: string }).deny ?? (r as { text?: string }).text ?? '')
const notes = (r: object) => ((r as { context?: readonly string[] }).context ?? []).join('\n')

const slash = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

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
    // 76 of the week's 168 hours are gone: 10% so far is 22% by the reset.
    expect(await ui.find({ type: 'Text', text: /wk 10% \(pace 22%\)/ })).toBeDefined()
    await ui.unmount()
  }

  // Over pace: 60% with 45% of the week gone would pass 100% before the reset.
  await $.session.measure(measure(230_000, 62, 60))
  const over = await $.ui.mount({ ...band, surface: 'terminal' })
  expect(await over.find({ type: 'Text', text: /wk 60% \(pace 133%\)/ })).toBeDefined()
  await over.unmount()

  await clock.set(Date.parse('2026-11-21T16:41:00Z'))
  const later = await $.ui.mount({ ...band, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: /ctx 230k/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /wk 60%/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /5h/ })).toBeUndefined()
  expect(await later.find({ type: 'Text', text: /95% in/ })).toBeUndefined()
  await later.unmount()
})

// A config folder in memory: what the plugin wrote, by path.
const disk = (on: Parameters<TestBody>[1], files: Record<string, string> = {}, there?: RegExp) => {
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path in files || (there?.test(e.path) ?? false) }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: Object.keys(files)
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: files[path]?.length ?? 0, mtimeMs: T0, isLink: false })),
  }))
  return files
}

const stepUsage = (model: string, input: number, output: number, read: number, write1h: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write1h,
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: write1h,
  model,
})

test('each reading with news is logged with the tokens every model call used since the last one', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = disk(on)
  const calls = [stepUsage('claude-fable-5-2', 2, 300, 40_000, 12_000), stepUsage('claude-sonnet-5-5', 5, 50, 0, 30_000)]
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: calls[e.index] ?? null }
  })
  const step = async (index: number, agentId?: string) => {
    for await (const _chunk of $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })) void _chunk
  }

  await step(0)
  await step(1, 'a1')
  await $.session.measure(measure(40_000, 11))
  const [path] = Object.keys(files)
  expect(path).toMatch(/^\/cfg\/token-diet\/usage\/2026-11-21-[0-9a-f]{8}\.jsonl$/)
  const first = JSON.parse(files[path ?? ''] ?? '')
  expect(first).toEqual({
    t: T0,
    five: [11, '2026-11-21T16:40:00Z'],
    wk: [10, '2026-11-25T08:00:00Z'],
    ctx: 40_000,
    d: { 'claude-fable-5-2': [2, 300, 40_000, 0, 12_000], 'claude-sonnet-5-5': [5, 50, 0, 0, 30_000] },
  })

  // Nothing spent and no window moved: no line. A window that moved: one more line, appended.
  await clock.advance(MIN)
  await $.session.measure(measure(40_000, 11))
  await $.session.measure(measure(40_000, 12))
  const lines = (files[path ?? ''] ?? '').trim().split('\n')
  expect(lines.length).toBe(2)
  expect(JSON.parse(lines[1] ?? '')).toEqual({ t: T0 + MIN, five: [12, '2026-11-21T16:40:00Z'], wk: [10, '2026-11-25T08:00:00Z'], ctx: 40_000 })
})

test('usageLog off writes nothing', { options: { usageLog: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const files = disk(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure(measure(40_000, 11))
  expect(Object.keys(files)).toEqual([])
})

// Four 5-hour windows of six stretches each, across two session files, in which every point
// costs half a dollar of fresh tokens or a dollar of cache reads (at Sonnet 5.5 list prices).
const syntheticLog = () => {
  const files: Record<string, string> = {}
  for (let w = 0; w < 4; w++) {
    const resets = new Date(T0 - (4 - w) * 5 * 60 * MIN).toISOString()
    let t = Date.parse(resets) - 4 * 60 * MIN
    let p = 3
    const rows = [{ t, five: [p, resets] }]
    for (let i = 0; i < 6; i++) {
      const fresh = 2 + ((i * 7 + w * 3) % 5)
      const read = 1 + ((i * 3 + w) % 4)
      p += 2 * fresh + read
      t += 20 * MIN
      rows.push({ t, five: [p, resets], d: { 'claude-sonnet-5-5': [fresh * 500_000, 0, read * 10_000_000, 0, 0] } } as never)
    }
    const path = `/cfg/token-diet/usage/2026-11-2${w % 2}-0000000${w % 2}.jsonl`
    files[path] = (files[path] ?? '') + rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  }
  return files
}

test('the usage report gives the weight of cache reads once the log can carry one', async ($, on) => {
  mock.clock(on, { now: T0 })
  disk(on, syntheticLog())
  const full = await $.command.run(slash('token-diet-usage'))
  expect(full.isTextDisplayOnly).toBe(true)
  expect(full.text).toContain('2 session files')
  expect(full.text).toContain('weighs cache reads: 0.50 ± 0.00 of their API price')
  expect(full.text).toContain('from 24 stretches')
  expect(full.text).toContain('another Claude Code profile')
})

test('a thin usage log is reported as inconclusive', async ($, on) => {
  mock.clock(on, { now: T0 })
  const all = syntheticLog()
  const [path, text] = Object.entries(all)[0] ?? ['', '']
  disk(on, { [path]: text.split('\n').slice(0, 5).join('\n') })
  const thin = await $.command.run(slash('token-diet-usage', '3'))
  expect(thin.text).toContain('last 3 days')
  expect(thin.text).toContain('inconclusive')
  expect(thin.text).not.toContain('of their API price')
})

const HANDOFF_REPLY = [
  'slug: Billing Export!',
  '# Handoff: billing export (2026-11-21)',
  '## Goal',
  '- ship the export',
  '## Done',
  '- parser, commit abc1234',
  '## In progress',
  '- branch export-csv',
  '## In flight',
  'None',
  '## Deliverables',
  'None',
  '## Decisions',
  '- CSV only',
  '## Next',
  '1. run the tests',
].join('\n')

// Answers the fork the way a session does, and counts the forks.
const forks = (on: Parameters<TestBody>[1], text: string) => {
  const asked: { prompt: string; effort?: string }[] = []
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('model.fork', (_, e) => {
    asked.push(e)
    return { value: { isAnswered: true as const, text, usage: { input_tokens: 40, output_tokens: 400, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 } } }
  })
  return asked
}

test('at the hard limit the plugin writes the handoff itself, once, into a file of its own', async ($, on) => {
  const ran: string[] = []
  mock.clock(on, { now: T0 })
  const files = disk(on, {}, /(^|\/)handoffs$/)
  const asked = forks(on, HANDOFF_REPLY)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_, e) => (ran.push(e.tool), { result: {} }))

  await $.session.measure(measure(210_000, 96))
  // Two tool calls of one step are both denied and share the one fork.
  const [first, second] = await Promise.all([$.tool.call({ tool: 'Bash', command: 'ls' }), $.tool.call({ tool: 'Bash', command: 'pwd' })])
  expect(asked.length).toBe(1)
  expect(asked[0]?.effort).toBeUndefined()
  expect(asked[0]?.prompt).toContain('## In flight')

  const path = Object.keys(files).find(name => /handoffs\//.test(name)) ?? ''
  expect(path).toMatch(/handoffs\/2026-11-21-billing-export-[0-9a-f]{8}\.md$/)
  expect(files[path]).toContain('# Handoff: billing export')
  expect(files[path]).toContain('## Next\n1. run the tests')
  expect(files[path]).not.toContain('slug:')
  expect(files[path]).toContain('Written by token-diet at the usage limit')
  for (const denied of [first, second]) {
    expect(why(denied)).toContain('token-diet has written this session')
    expect(why(denied)).toMatch(/resume handoffs\/2026-11-21-billing-export-[0-9a-f]{8}\.md/)
  }

  // Later calls in the same window are denied without another fork; the file stays editable.
  expect(why(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('token-diet has written')
  await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })
  expect(asked.length).toBe(1)
  expect(ran).toEqual(['Edit'])

  // The fork's tokens are in the usage log.
  await $.session.measure(measure(210_000, 97))
  const log = Object.entries(files).find(([name]) => name.endsWith('.jsonl'))?.[1] ?? ''
  expect(log).toContain('"claude-fable-5-2":[40,400,200000,0,0]')
})

test('a plain handoff file this session does not hold is left alone', async ($, on) => {
  mock.clock(on, { now: T0 })
  const files = disk(on, {}, /(^|\/)HANDOFF\.md$/)
  forks(on, HANDOFF_REPLY)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(210_000, 96))
  const denied = why(await $.tool.call({ tool: 'Bash', command: 'ls' }))
  const written = Object.keys(files).filter(name => name.endsWith('.md'))
  expect(written.length).toBe(1)
  expect(written[0]).toMatch(/HANDOFF-[0-9a-f]{8}\.md$/)
  expect(denied).toMatch(/resume HANDOFF-[0-9a-f]{8}\.md/)
})

test('a handoff this session wrote earlier is brought up to date in place', async ($, on) => {
  mock.clock(on, { now: T0 })
  const files = disk(on)
  const asked = forks(on, HANDOFF_REPLY)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Write') files[e.file_path] = e.content
    return { result: {} }
  })

  await $.session.measure(measure(100_000, 50))
  await $.tool.call({ tool: 'Write', file_path: '/repo/HANDOFF.md', content: '# Handoff: old notes' })
  await $.tool.call({ tool: 'Bash', command: 'npm   test\n-- export' })
  await $.session.measure(measure(210_000, 96))
  expect(why(await $.tool.call({ tool: 'Bash', command: 'git push' }))).toContain('resume /repo/HANDOFF.md')
  expect(asked[0]?.prompt).toContain('# Handoff: old notes')
  // The fork is told the steps it cannot see yet, and which one never ran.
  expect(asked[0]?.prompt).toContain('- Write: /repo/HANDOFF.md\n- Bash: npm test -- export\n- Bash: git push (blocked by the usage limit)')
  expect(files['/repo/HANDOFF.md']).toContain('# Handoff: billing export')
})

test('a current handoff, a reply that is no handoff, or autoHandoff off: Claude is asked as before', async ($, on) => {
  mock.clock(on, { now: T0 })
  const files = disk(on)
  const asked = forks(on, 'Sorry, here is a summary instead: all good.')
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  // No handoff in the reply: nothing is written and the old instruction stands.
  await $.session.measure(measure(210_000, 96))
  expect(why(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('If the handoff is not written yet, write it')
  expect(asked.length).toBe(1)
  expect(Object.keys(files).filter(name => name.endsWith('.md'))).toEqual([])

  // The next 5-hour window: Claude wrote the handoff 10k tokens ago, so no fork is made.
  const next = { ...measure(215_000, 50), rateLimits: [{ kind: 'five_hour', percentUsed: 50, resetsAt: '2026-11-21T21:40:00Z' }] }
  await $.session.measure(next)
  await $.tool.call({ tool: 'Write', file_path: '/repo/HANDOFF.md', content: 'x' })
  await $.session.measure({ ...next, context: { ...next.context, tokens: 225_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 96, resetsAt: '2026-11-21T21:40:00Z' }] })
  expect(why(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('Only the handoff file (/repo/HANDOFF.md)')
  expect(asked.length).toBe(1)
})

test('autoHandoff off makes no fork', { options: { autoHandoff: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  disk(on)
  const asked = forks(on, HANDOFF_REPLY)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.measure(measure(210_000, 96))
  expect(why(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('If the handoff is not written yet, write it')
  expect(asked.length).toBe(0)
})

const skill = (text: string, extra: object = {}) => ({ skill: 'big-skill', text, frontmatter: {}, source: 'plugin' as const, pluginName: 'other', ...extra })

test('skill text is left whole by default, whatever its length', async ($, on) => {
  on('skill.prompt', (_, e) => ({ text: e.text }))
  const long = 'x'.repeat(50_000)
  expect((await $.skill.prompt(skill(long))).text).toBe(long)
})

test('skillBodyMaxChars cuts a longer skill text and names the file to read', { options: { skillBodyMaxChars: 100 } }, async ($, on) => {
  on('skill.prompt', (_, e) => ({ text: e.text }))
  const cut = (await $.skill.prompt(skill('x'.repeat(250), { path: '/s/big/SKILL.md' }))).text
  expect(cut.startsWith('x'.repeat(100) + '\n')).toBe(true)
  expect(cut).not.toContain('x'.repeat(101))
  expect(cut).toContain('150 of 250 chars not shown')
  expect(cut).toContain('Read /s/big/SKILL.md for the rest')

  // A skill with no file on this machine gets the line without a path.
  expect((await $.skill.prompt(skill('x'.repeat(250)))).text).not.toContain('Read ')

  // Not longer than the cap, or token-diet's own: untouched.
  expect((await $.skill.prompt(skill('x'.repeat(100)))).text).toBe('x'.repeat(100))
  const own = await $.skill.prompt(skill('x'.repeat(250), { skill: 'token-diet:other', pluginName: 'token-diet' }))
  expect(own.text).toBe('x'.repeat(250))
})

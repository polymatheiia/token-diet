import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Snap } from '../types'

const snapAtom = atom({ plugin: 'token-diet', key: 'snap' } as const, null)
const notesAtom = atom({ plugin: 'token-diet', key: 'notes' } as const, [])
const ctxStepAtom = atom({ plugin: 'token-diet', key: 'ctxStep' } as const, 0)
const softFiredAtom = atom({ plugin: 'token-diet', key: 'softFired' } as const, [])

const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }
const STRONG = /\b(opus|fable)\b/i
const DOWNGRADE_TYPES = new Set(['general-purpose', 'Explore', 'Plan', 'claude'])
const READS_AND_WRITES = new Set(['Read', 'Write', 'Edit'])

type Options = {
  contextNudgeTokens: number
  softLimitPercent: number
  hardLimitPercent: number
  handoffFile: string
  subagentModel: string
}

export const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

export const hhmm = (iso?: string) => {
  if (!iso) return '?'
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const left = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const min = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}m`
}

export const isHandoffPath = (path: string, handoffFile: string) => {
  const base = (handoffFile.split('/').pop() ?? handoffFile).toLowerCase()
  const p = path.toLowerCase()
  return p.endsWith(`/${base}`) || p === base || /(^|\/)[^/]*handoff[^/]*\.md$/.test(p) || /(^|\/)handoffs?\/[^/]+\.md$/.test(p)
}

async function queue($: EngineInterface, note: string) {
  await update($, notesAtom, list => [...list, note])
}

const tracked = (limits: Limit[]) => limits.filter(l => l.kind in WINDOWS)

export const register: Register = (on, options) => {
  const o = options as unknown as Options
  let lastPrompt = ''

  on('session.measure', async ($, e, next) => {
    const snap: Snap = {
      tokens: e.context.tokens,
      window: e.context.window,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    }
    await update($, snapAtom, () => snap)

    // Context nudge: once per multiple of the threshold; reset after /clear or compaction.
    const tokens = e.context.tokens ?? 0
    const step = o.contextNudgeTokens > 0 ? Math.floor(tokens / o.contextNudgeTokens) : 0
    const prevStep = await read($, ctxStepAtom)
    if (step < prevStep) await update($, ctxStepAtom, () => step)
    if (step >= 1 && step > prevStep) {
      await update($, ctxStepAtom, () => step)
      $.ui.toast(`Context ${k(tokens)}: good moment for /token-diet:handoff, then /clear`)
      await queue(
        $,
        `[token-diet] Context is now ~${k(tokens)} tokens and every call re-reads all of it. ` +
          `At the next natural stopping point (not mid-edit): update ${o.handoffFile} ` +
          `(Done / In progress / Decisions / Next), then tell the user it is a good moment to /clear ` +
          `and resume from the handoff. Do not start new side-quests in this session.`,
      )
    }

    // Soft limit: once per window per reset.
    const fired = await read($, softFiredAtom)
    for (const l of tracked(snap.limits)) {
      const key = `${l.kind}@${l.resetsAt ?? ''}`
      if (l.percentUsed >= o.softLimitPercent && !fired.includes(key)) {
        await update($, softFiredAtom, list => [...list.filter(x => !x.startsWith(`${l.kind}@`)), key])
        $.ui.toast(`${WINDOWS[l.kind]} usage ${Math.floor(l.percentUsed)}% (resets ${hhmm(l.resetsAt)}): write the handoff now`)
        await queue(
          $,
          `[token-diet] ${WINDOWS[l.kind]} usage is at ${Math.floor(l.percentUsed)}% (resets ${hhmm(l.resetsAt)}). ` +
            `Before any more work: write the deliverable the user is waiting for (report, summary, PR text) ` +
            `and update ${o.handoffFile}. At ${o.hardLimitPercent}% every tool call except reading/writing ` +
            `the handoff file is blocked.`,
        )
      }
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    // Only the person's own typing decides whether Opus/Fable subagents were asked for.
    if (e.origin?.kind === 'composer') lastPrompt = e.text
    const notes = await read($, notesAtom)
    if (notes.length === 0) return next(e)
    await update($, notesAtom, () => [])
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // Hard guard: at the hard limit only the handoff file may be read or written.
    const snap = await read($, snapAtom)
    const over = tracked(snap?.limits ?? []).filter(l => l.percentUsed >= o.hardLimitPercent)
    if (over.length > 0) {
      const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
      const isHandoff = READS_AND_WRITES.has(e.tool) && path !== '' && isHandoffPath(path, o.handoffFile)
      if (!isHandoff) {
        const which = over.map(l => `${WINDOWS[l.kind]} ${Math.floor(l.percentUsed)}% (resets ${hhmm(l.resetsAt)})`).join(', ')
        return {
          deny:
            `[token-diet] Usage ${which} is at or above ${o.hardLimitPercent}%. Only ${o.handoffFile} may be ` +
            `read or written now. If the handoff is not written yet, write it; then stop and tell the user.`,
        }
      }
    }

    // Subagent model: keep general lanes off Opus/Fable unless the user asked for them.
    let input = e
    if (e.tool === 'Agent' && o.subagentModel !== 'off' && !STRONG.test(lastPrompt)) {
      const type = e.subagent_type ?? 'general-purpose'
      const asksStrong = typeof e.model === 'string' && STRONG.test(e.model)
      if (type !== 'fork' && (asksStrong || (e.model === undefined && DOWNGRADE_TYPES.has(type)))) {
        input = { ...e, model: o.subagentModel as 'sonnet' | 'haiku' }
      }
    }

    const ran = await next(input)

    // Deliver queued notes mid-turn, on the main loop only.
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const notes = await read($, notesAtom)
      if (notes.length > 0) {
        await update($, notesAtom, () => [])
        return { ...ran, context: [...(ran.context ?? []), ...notes] }
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapAtom)
    if (e.props.hasSurvey || snap === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    const tokens = snap.tokens ?? 0
    const ctxColor = tokens >= 2 * o.contextNudgeTokens ? 'red' : tokens >= o.contextNudgeTokens ? 'yellow' : undefined
    const limColor = (p: number) => (p >= o.hardLimitPercent ? 'red' : p >= o.softLimitPercent ? 'yellow' : undefined)

    return (
      <Box>
        <Text dimColor={ctxColor === undefined} color={ctxColor}>
          ctx {snap.tokens === undefined ? '–' : k(tokens)}/{k(snap.window)}
        </Text>
        {tracked(snap.limits).map(l => (
          <Text key={l.kind} dimColor={limColor(l.percentUsed) === undefined} color={limColor(l.percentUsed)}>
            {'  ·  '}
            {WINDOWS[l.kind]} {Math.floor(l.percentUsed)}%
            {l.kind === 'five_hour' ? ` → ${hhmm(l.resetsAt)} (${left(l.resetsAt, now)})` : ''}
          </Text>
        ))}
      </Box>
    )
  })
}

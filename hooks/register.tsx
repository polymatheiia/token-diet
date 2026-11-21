import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Snap } from '../types'
import { addUsage, isEmpty, parseRows, report } from './usage'
import type { Row, Spent } from './usage'

const snapAtom = atom({ plugin: 'token-diet', key: 'snap' } as const, null)
const notesAtom = atom({ plugin: 'token-diet', key: 'notes' } as const, [])
const ctxStepAtom = atom({ plugin: 'token-diet', key: 'ctxStep' } as const, 0)
const softFiredAtom = atom({ plugin: 'token-diet', key: 'softFired' } as const, [])
const handoffAtom = atom({ plugin: 'token-diet', key: 'handoff' } as const, null)
const samplesAtom = atom({ plugin: 'token-diet', key: 'samples' } as const, [])
const etaAtom = atom({ plugin: 'token-diet', key: 'eta' } as const, null)
const sidAtom = atom({ plugin: 'token-diet', key: 'sid' } as const, '')
const spentAtom = atom({ plugin: 'token-diet', key: 'spent' } as const, {})
const logPathAtom = atom({ plugin: 'token-diet', key: 'logPath' } as const, '')
const loggedAtom = atom({ plugin: 'token-diet', key: 'logged' } as const, '')
const autoAtom = atom({ plugin: 'token-diet', key: 'auto' } as const, null)

const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }
const STRONG = /\b(opus|fable)\b/i
// "don't use opus", "without fable", "sonnet instead of opus": a mention that is not a request.
const NEGATED = /\b(no|not|don'?t|never|without|avoid|skip|instead of)\b[^.\n]{0,24}?\b(opus|fable)\b(\s*(,|or|and|nor)\s*(opus|fable)\b)*/gi
// Asked for by name, once the negated mentions are taken out ("use opus, not fable" still asks for opus).
const wantsStrong = (text: string) => STRONG.test(text.replace(NEGATED, ' '))
const DOWNGRADE_TYPES = new Set(['general-purpose', 'Explore', 'Plan', 'claude'])
const READS_AND_WRITES = new Set(['Read', 'Write', 'Edit'])
const WRITES = new Set(['Write', 'Edit'])
const HANDOFF_DIRS = ['handoffs', 'handoff']
const ID_SUFFIX = /-[0-9a-f]{8}\.md$/
const MIN = 60_000
const DAY = 24 * 60 * MIN
const WEEK = 7 * DAY
// Burn rate: measured over at most this long, and only once it spans this much time and rise.
const RATE_WINDOW_MIN = 15
const RATE_MIN_SPAN_MIN = 3
const RATE_MIN_RISE = 3
// A handoff written within this much context growth is current: the plugin does not write over it.
const FRESH_TOKENS = 20_000
const SECTIONS = ['Goal', 'Done', 'In progress', 'In flight', 'Deliverables', 'Decisions', 'Next']

type Options = {
  contextNudgeTokens: number
  softLimitPercent: number
  hardLimitPercent: number
  handoffFile: string
  autoHandoff: boolean
  usageLog: boolean
  subagentModel: string
  spawnGateTokens: number
  runwayMinutes: number
  keepStrongFor: string
}

export const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

const pad = (n: number) => String(n).padStart(2, '0')

export const hhmm = (iso?: string) => {
  if (!iso) return '?'
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const ymd = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const left = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const min = Math.max(0, Math.round((Date.parse(iso) - now) / MIN))
  return min >= 60 ? `${Math.floor(min / 60)}h${pad(min % 60)}` : `${min}m`
}

// The weekly percentage the window would end on at its average rate so far; null in the first
// tenth of the window (too little to go on) and once it has reset.
export const weekPace = (l: Limit, now: number) => {
  if (l.resetsAt === undefined) return null
  const elapsed = 1 - (Date.parse(l.resetsAt) - now) / WEEK
  return elapsed >= 0.1 && elapsed <= 1 ? l.percentUsed / elapsed : null
}

const baseName = (path: string) => (path.split('/').pop() ?? path).toLowerCase()

export const isHandoffPath = (path: string, handoffFile: string) => {
  const base = baseName(handoffFile)
  const p = path.toLowerCase()
  return p.endsWith(`/${base}`) || p === base || /(^|\/)[^/]*handoff[^/]*\.md$/.test(p) || /(^|\/)handoffs?\/[^/]+\.md$/.test(p)
}

// A window that has already reset no longer counts, whatever the last reading said.
const live = (l: Limit, now: number) => !(l.resetsAt !== undefined && Date.parse(l.resetsAt) <= now)

async function queue($: EngineInterface, note: string) {
  await update($, notesAtom, list => [...list, note])
}

// This session's own 8-hex tag, made once and kept in session state.
async function tag($: EngineInterface) {
  const id8 = await read($, sidAtom)
  if (id8 !== '') return id8
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  const made = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  await update($, sidAtom, held => (held === '' ? made : held))
  return read($, sidAtom)
}

// The tag and the project's handoffs folder, if it has one. The tag in the file name is what
// keeps parallel sessions in one folder apart.
async function locate($: EngineInterface) {
  const id8 = await tag($)
  let dir = ''
  if (id8 !== '') {
    for (const d of HANDOFF_DIRS) {
      try {
        if (await $.fs.exists(d)) {
          dir = d
          break
        }
      } catch {}
    }
  }
  return { id8, dir }
}

// Where this session's handoff goes: the file it already wrote, else a file of its own in the
// project's handoffs folder (the session id keeps parallel sessions apart), else the plain file.
async function target($: EngineInterface, handoffFile: string) {
  const held = await read($, handoffAtom)
  if (held !== null) return held.path
  const { id8, dir } = await locate($)
  return dir === '' ? handoffFile : `${dir}/${ymd(await $.clock.now())}-<topic>-${id8}.md`
}

async function isOwnHandoff($: EngineInterface, path: string, handoffFile: string) {
  if (!isHandoffPath(path, handoffFile)) return false
  const held = await read($, handoffAtom)
  if (held !== null && held.path === path) return true
  const p = path.toLowerCase()
  const { id8, dir } = await locate($)
  if (ID_SUFFIX.test(p)) return id8 !== '' && p.endsWith(`-${id8}.md`)
  return dir === '' && baseName(p) === baseName(handoffFile)
}

const tracked = (limits: Limit[]) => limits.filter(l => l.kind in WINDOWS)

// What the fork is asked at the hard limit. No effort is named and haste is asked for in words,
// so nothing moves ahead of the prompt and the conversation is read from the cache.
export const handoffAsk = (date: string, existing: string, recent: string[] = []) =>
  `[token-diet] The usage limit is reached and this session is about to be stopped. You have no tools here. ` +
  `Answer straight away, without thinking it over, with the full text of this session's handoff file and nothing else. ` +
  `A fresh session with no context must be able to continue from it alone. Under 60 lines, terse bullets, ` +
  `concrete identifiers (paths, branches, commit SHAs, task numbers, exact commands).\n\n` +
  `First line exactly: slug: <2-4 lowercase words joined by hyphens that name this work>\n` +
  `Then the file, with exactly these headings:\n# Handoff: <topic> (${date})\n` +
  SECTIONS.map(name => `## ${name}`).join('\n') +
  `\n\nIn flight lists everything still running or owned elsewhere (background agents, peer sessions, wakeups, ` +
  `long commands), or "None". Deliverables holds anything the user asked for that exists only in this conversation.` +
  // A fork is sent the conversation as of the request before the last one: the newest step is missing from it.
  (recent.length === 0
    ? ''
    : `\n\nThe conversation you see ends one step early. This session's most recent tool calls, oldest first ` +
      `(count the ones you do not see as made; one marked blocked did not run):\n${recent.map(line => `- ${line}`).join('\n')}`) +
  (existing === '' ? '' : `\n\nThe file as it stands; bring it up to date and keep what still holds:\n\n${existing.slice(0, 20_000)}`)

// A tool call in one line, for the list above.
const brief = (call: Record<string, unknown>) => {
  const detail = ['command', 'file_path', 'description', 'pattern', 'skill'].map(key => call[key]).find(v => typeof v === 'string' && v !== '')
  return typeof detail === 'string' ? `${String(call.tool)}: ${detail.replace(/\s+/g, ' ').slice(0, 160)}` : String(call.tool)
}

// The reply as a file: its slug line taken off, any code fence around it dropped. Null when it
// is not a handoff (no Done and Next sections).
export const handoffFrom = (reply: string) => {
  let text = reply.trim().replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '').trim()
  const named = /^slug:\s*(.+)\n/i.exec(text)
  if (named !== null) text = text.slice(named[0].length).trim()
  if (!/^##\s*Done\b/im.test(text) || !/^##\s*Next\b/im.test(text)) return null
  const slug = (named?.[1] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return { slug: slug === '' ? 'session' : slug, text }
}

// At the hard limit the plugin writes the handoff itself: one tool-less fork of the conversation,
// its reply saved as this session's handoff file. Resolves to the path written, or '' when nothing
// was (already current, the fork gave no handoff, any failure): the caller then asks Claude for it.
// It never rejects, and never writes a file this session does not hold or name by its own tag.
async function autoHandoff($: EngineInterface, handoffFile: string, key: string, tokens: number, recent: string[]) {
  try {
    const done = await read($, autoAtom)
    if (done !== null && done.key === key) return done.path
    await update($, autoAtom, () => ({ key, path: '' }))
    const held = await read($, handoffAtom)
    if (held !== null && held.at > 0 && tokens - held.at <= FRESH_TOKENS) return ''
    const now = await $.clock.now()
    let existing = ''
    if (held !== null) {
      try {
        existing = await $.fs.read(held.path)
      } catch {}
    }
    const reply = await $.model.fork({ prompt: handoffAsk(ymd(now), existing, recent) })
    if (!reply.isAnswered) return ''
    const made = handoffFrom(reply.text)
    if (made === null) return ''
    let path = held?.path ?? ''
    if (path === '') {
      const { id8, dir } = await locate($)
      if (dir !== '') path = `${dir}/${ymd(now)}-${made.slug}-${id8}.md`
      // A plain handoff file that is already there may be another session's or older work's.
      else path = (await $.fs.exists(handoffFile)) ? handoffFile.replace(/(\.md)?$/i, `-${id8}.md`) : handoffFile
    }
    await $.fs.write(path, `${made.text}\n\n_Written by token-diet at the usage limit (${hhmm(new Date(now).toISOString())}), from the conversation; not reviewed, and the last step before the limit may be missing._\n`)
    await update($, handoffAtom, () => ({ path, at: tokens }))
    await update($, autoAtom, () => ({ key, path }))
    if (reply.usage !== undefined) {
      const model = await $.session.model()
      await update($, spentAtom, spent => addUsage(spent, { ...reply.usage, model }))
    }
    $.ui.toast(`Usage limit: handoff written to ${path}`)
    return path
  } catch {
    return ''
  }
}

// The usage log lives beside the user's Claude Code configuration, one file per session, so
// parallel sessions never write the same file and no project folder is touched.
async function usageDir($: EngineInterface) {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  return `${config}/token-diet/usage`
}

// One line per measurement that has news: the two windows, the context size, and the tokens
// every model call of this session (subagents included) used since the line before.
async function logRow($: EngineInterface, snap: Snap, now: number) {
  const five = snap.limits.find(l => l.kind === 'five_hour')
  const wk = snap.limits.find(l => l.kind === 'seven_day')
  const seen = `${five?.percentUsed}@${five?.resetsAt}|${wk?.percentUsed}@${wk?.resetsAt}`
  if (isEmpty(await read($, spentAtom)) && seen === (await read($, loggedAtom))) return
  let spent: Spent = {}
  await update($, spentAtom, held => {
    spent = held
    return {}
  })
  await update($, loggedAtom, () => seen)
  let path = await read($, logPathAtom)
  if (path === '') {
    path = `${await usageDir($)}/${ymd(now)}-${await tag($)}.jsonl`
    await update($, logPathAtom, () => path)
  }
  let before = ''
  try {
    before = await $.fs.read(path)
  } catch {
    // Unreadable but there (over the read limit): leave it whole and carry on in a new file.
    if (await $.fs.exists(path)) {
      path = path.replace(/\.jsonl$/, `-${now}.jsonl`)
      await update($, logPathAtom, () => path)
    }
  }
  const row: Row = { t: now }
  if (five !== undefined) row.five = [five.percentUsed, five.resetsAt ?? '']
  if (wk !== undefined) row.wk = [wk.percentUsed, wk.resetsAt ?? '']
  if (snap.tokens !== undefined) row.ctx = snap.tokens
  if (!isEmpty(spent)) row.d = spent
  await $.fs.write(path, `${before}${JSON.stringify(row)}\n`)
}

async function usageReport($: EngineInterface, days: number) {
  const dir = await usageDir($)
  const now = await $.clock.now()
  let names: string[] = []
  try {
    names = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && now - f.mtimeMs <= days * DAY).map(f => f.name)
  } catch {}
  const rows: Row[] = []
  let files = 0
  for (const name of names) {
    try {
      rows.push(...parseRows(await $.fs.read(`${dir}/${name}`)).filter(row => now - row.t <= days * DAY))
      files += 1
    } catch {}
  }
  return report(rows, files, days)
}

export const register: Register = (on, options) => {
  const o = options as unknown as Options
  const keep = (o.keepStrongFor ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s !== '')
  let lastPrompt = ''
  let toldDowngrade = false
  // Set while the handoff skill is in use and no file is held: the next tagged handoff read is a resume.
  let resuming = false
  // The automatic handoff in flight or done, by the windows over the limit: parallel tool calls
  // denied in one step wait for the one fork.
  let auto: { key: string; done: Promise<string> } | null = null
  // The main loop's last few tool calls, one line each: what a fork cannot see yet.
  const recent: string[] = []
  const naming = (path: string) => (path.includes('<topic>') ? ' (replace <topic> with a 2-4 word slug)' : '')

  // The handoff must have been written at or after this context size before the main loop may
  // start more agents; null while the gate is off or not reached.
  const gateFloor = (tokens: number) => {
    if (!(o.spawnGateTokens > 0) || tokens < o.spawnGateTokens) return null
    const n = o.contextNudgeTokens
    const step = n > 0 ? Math.max(o.spawnGateTokens, Math.floor(tokens / n) * n) : o.spawnGateTokens
    return step - (n > 0 ? n / 3 : 50_000)
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-diet-usage',
      description: 'What the usage log says about how the 5-hour limit counts cache reads',
      argumentHint: '[days]',
    })
    return next(e)
  })

  // Shown to the person only: the report costs no context.
  on('command.run', { command: 'token-diet-usage' }, async ($, e) => {
    const days = Number.parseInt(e.args, 10)
    return { text: await usageReport($, days > 0 ? days : 7), isTextDisplayOnly: true }
  })

  // Every model call of the session, a subagent's too: its token counts go to the usage log.
  if (o.usageLog !== false) {
    on('turn.step', async function* ($, e, next) {
      const ran = yield* next(e)
      const usage = ran.usage
      if (usage !== null) {
        try {
          await update($, spentAtom, held => addUsage(held, usage))
        } catch {}
      }
      return ran
    })
  }

  on('session.measure', async ($, e, next) => {
    const snap: Snap = {
      tokens: e.context.tokens,
      window: e.context.window,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    }
    await update($, snapAtom, () => snap)
    const now = await $.clock.now()
    if (o.usageLog !== false) {
      try {
        await logRow($, snap, now)
      } catch {}
    }

    // Context nudge: once per multiple of the threshold; reset after /clear or compaction.
    const tokens = e.context.tokens ?? 0
    const step = o.contextNudgeTokens > 0 ? Math.floor(tokens / o.contextNudgeTokens) : 0
    const prevStep = await read($, ctxStepAtom)
    if (step < prevStep) {
      await update($, ctxStepAtom, () => step)
      await update($, handoffAtom, held => (held === null ? null : { ...held, at: 0 }))
    }
    if (step >= 1 && step > prevStep) {
      await update($, ctxStepAtom, () => step)
      const path = await target($, o.handoffFile)
      if (step === 1) {
        $.ui.toast(`Context ${k(tokens)}: good moment for /token-diet:handoff, then /clear`)
        await queue(
          $,
          `[token-diet] Context is now ~${k(tokens)} tokens and every call re-reads all of it. ` +
            `At the next natural stopping point (not mid-edit): update ${path}${naming(path)} ` +
            `(Done / In progress / In flight / Decisions / Next), then tell the user it is a good moment to /clear ` +
            `and resume from the handoff. Do not start new side-quests in this session.`,
        )
      } else {
        $.ui.toast(`Context ${k(tokens)} (nudge ${step}): handoff, then /clear now`)
        await queue(
          $,
          `[token-diet] Context is now ~${k(tokens)} tokens (nudge ${step}); most of this session's cost is ` +
            `re-reading it. Start nothing new here. Finish the step in hand, update ${path}${naming(path)} with ` +
            `Write or Edit, then tell the user plainly: /clear now, then /token-diet:handoff resume <that path>. ` +
            `Remaining work belongs in the fresh session.`,
        )
      }
    }

    const fired = await read($, softFiredAtom)
    const fire = async (prefix: string, key: string, toast: string, note: string) => {
      await update($, softFiredAtom, list => [...list.filter(x => !x.startsWith(prefix)), key])
      $.ui.toast(toast)
      await queue($, note)
    }
    const orders = async () => {
      const path = await target($, o.handoffFile)
      return (
        `Before any more work: write the deliverable the user is waiting for (report, summary, PR text) ` +
        `and update ${path}${naming(path)}. At ${o.hardLimitPercent}% every tool call except reading/writing ` +
        `the handoff file is blocked.`
      )
    }

    // Runway: the 5-hour window's burn rate, projected to the hard limit.
    const five = snap.limits.find(l => l.kind === 'five_hour')
    let eta: number | null = null
    if (five !== undefined && live(five, now)) {
      const r = five.resetsAt ?? ''
      const recent = (await read($, samplesAtom)).filter(s => s.r === r && now - s.t <= RATE_WINDOW_MIN * MIN)
      const last = recent.at(-1)
      const samples = last === undefined || last.p !== five.percentUsed ? [...recent, { t: now, p: five.percentUsed, r }].slice(-60) : recent
      await update($, samplesAtom, () => samples)
      const first = samples[0]
      if (first !== undefined && five.percentUsed < o.hardLimitPercent) {
        const span = (now - first.t) / MIN
        const rise = five.percentUsed - first.p
        if (span >= RATE_MIN_SPAN_MIN && rise >= RATE_MIN_RISE) eta = (o.hardLimitPercent - five.percentUsed) / (rise / span)
      }
      const key = `runway:five_hour@${r}`
      if (eta !== null && o.runwayMinutes > 0 && eta <= o.runwayMinutes && five.percentUsed < o.softLimitPercent && !fired.includes(key)) {
        const mins = Math.max(1, Math.round(eta))
        await fire(
          'runway:five_hour@',
          key,
          `5h usage ${Math.floor(five.percentUsed)}%, about ${mins} min to ${o.hardLimitPercent}%: write the handoff now`,
          `[token-diet] 5h usage is at ${Math.floor(five.percentUsed)}% and rising fast: about ${mins} min to the ` +
            `${o.hardLimitPercent}% block at this rate (resets ${hhmm(five.resetsAt)}). ${await orders()}`,
        )
      }
    }
    await update($, etaAtom, () => (eta === null ? null : { minutes: eta, at: now }))

    // Soft limit: once per window per reset.
    for (const l of tracked(snap.limits)) {
      const key = `${l.kind}@${l.resetsAt ?? ''}`
      if (l.percentUsed >= o.softLimitPercent && live(l, now) && !fired.includes(key)) {
        await fire(
          `${l.kind}@`,
          key,
          `${WINDOWS[l.kind]} usage ${Math.floor(l.percentUsed)}% (resets ${hhmm(l.resetsAt)}): write the handoff now`,
          `[token-diet] ${WINDOWS[l.kind]} usage is at ${Math.floor(l.percentUsed)}% (resets ${hhmm(l.resetsAt)}). ${await orders()}`,
        )
      }
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    // Only the person's own typing decides whether Opus/Fable subagents were asked for.
    if (e.origin?.kind === 'composer') {
      lastPrompt = e.text
      toldDowngrade = false
    }
    const notes = await read($, notesAtom)
    if (notes.length === 0) return next(e)
    await update($, notesAtom, () => [])
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  }).catch(($, e, next) => next(e))

  // The handoff skill is told which file is this session's, so it never has to guess.
  on('skill.prompt', async ($, e, next) => {
    const ran = await next(e)
    if (e.pluginName !== 'token-diet' || !/(^|:)handoff$/.test(e.skill)) return ran
    const path = await target($, o.handoffFile)
    resuming = (await read($, handoffAtom)) === null
    return { text: `${ran.text}\n\n[token-diet] This session's handoff file: ${path}${naming(path)}.` }
  })

  on('tool.call', async ($, e, next) => {
    const main = e.agentId === undefined
    const snap = await read($, snapAtom)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    const line = brief(e as unknown as Record<string, unknown>)
    if (main) {
      recent.push(line)
      if (recent.length > 6) recent.shift()
    }

    // Hard guard: at the hard limit only the handoff file may be read or written.
    const hot = tracked(snap?.limits ?? []).filter(l => l.percentUsed >= o.hardLimitPercent)
    if (hot.length > 0) {
      const now = await $.clock.now()
      const over = hot.filter(l => live(l, now))
      const isHandoff = READS_AND_WRITES.has(e.tool) && path !== '' && isHandoffPath(path, o.handoffFile)
      if (over.length > 0 && !isHandoff) {
        const which = over.map(l => `${WINDOWS[l.kind]} ${Math.floor(l.percentUsed)}% (resets ${hhmm(l.resetsAt)})`).join(', ')
        const head = `[token-diet] Usage ${which} is at or above ${o.hardLimitPercent}%.`
        if (!main) {
          return { deny: `${head} Stop now: make no more tool calls and write no files. Return what you have so far as your final message.` }
        }
        if (o.autoHandoff !== false) {
          const key = over.map(l => `${l.kind}@${l.resetsAt ?? ''}`).join('|')
          const at = recent.lastIndexOf(line)
          if (at >= 0) recent[at] = `${line} (blocked by the usage limit)`
          if (auto === null || auto.key !== key) auto = { key, done: autoHandoff($, o.handoffFile, key, snap?.tokens ?? 0, [...recent]) }
          const written = await auto.done
          if (written !== '') {
            return {
              deny:
                `${head} token-diet has written this session's handoff to ${written} from the conversation so far. ` +
                `Make no more tool calls, and do not read or rewrite that file now. Tell the user in two lines: the limit ` +
                `and when it resets, and that the work continues with /token-diet:handoff resume ${written}.`,
            }
          }
        }
        const file = await target($, o.handoffFile)
        return {
          deny:
            `${head} Only the handoff file (${file}${naming(file)}) may be ` +
            `read or written now. If the handoff is not written yet, write it; then stop and tell the user.`,
        }
      }
    }

    // Spawn gate: a large main context does not start more agents until its handoff is current.
    if (main && e.tool === 'Agent') {
      const tokens = snap?.tokens ?? 0
      const floor = gateFloor(tokens)
      const held = await read($, handoffAtom)
      if (floor !== null && (held === null || held.at < floor)) {
        const file = await target($, o.handoffFile)
        return {
          deny:
            `[token-diet] Context is ~${k(tokens)} tokens. Before starting more agents from this session, bring ` +
            `${file}${naming(file)} up to date with Write or Edit (a Bash write does not count), including what is ` +
            `in flight; then retry this call. Consider telling the user to /clear and resume from it instead. ` +
            `(spawnGateTokens 0 turns this gate off.)`,
        }
      }
    }

    // Subagent model: keep agents off Opus/Fable unless the user asked for them or allow-listed them.
    let input = e
    let replaced: string | undefined
    if (e.tool === 'Agent' && o.subagentModel !== 'off' && !wantsStrong(lastPrompt)) {
      const type = e.subagent_type ?? 'general-purpose'
      const label = `${type} ${e.description ?? ''}`.toLowerCase()
      const asksStrong = typeof e.model === 'string' && STRONG.test(e.model)
      const kept = keep.some(word => label.includes(word))
      if (type !== 'fork' && !kept && (asksStrong || (e.model === undefined && DOWNGRADE_TYPES.has(type)))) {
        input = { ...e, model: o.subagentModel as 'sonnet' | 'haiku' }
        if (asksStrong) replaced = e.model
      }
    }

    const ran = await next(input)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const extra: string[] = []
    if (replaced !== undefined) {
      extra.push(
        `[token-diet] This agent ran on ${o.subagentModel}, not ${replaced}: the user's standing choice for subagents. ` +
          `Do not retry it on a stronger model or fall back to another one. If its result is not good enough, say so to the user.`,
      )
      if (!toldDowngrade) {
        toldDowngrade = true
        $.ui.toast(`Subagents asking for ${replaced} run on ${o.subagentModel} (say "use ${replaced}" to allow it for a turn)`)
      }
    }

    if (main) {
      // This session's handoff was read (a resume) or written: remember which file it is.
      if (path !== '' && READS_AND_WRITES.has(e.tool) && (await isOwnHandoff($, path, o.handoffFile))) {
        const wrote = WRITES.has(e.tool)
        await update($, handoffAtom, held => ({ path, at: wrote ? (snap?.tokens ?? 0) : (held?.at ?? 0) }))
      } else if (resuming && e.tool === 'Read' && path !== '' && ID_SUFFIX.test(path.toLowerCase()) && isHandoffPath(path, o.handoffFile)) {
        // Resuming another session's handoff: continue in that file. Reading one outside the
        // handoff skill (an orchestrator checking a peer) adopts nothing.
        resuming = false
        await update($, handoffAtom, held => held ?? { path, at: 0 })
      }
      // Deliver queued notes mid-turn, on the main loop only.
      const notes = await read($, notesAtom)
      if (notes.length > 0) {
        await update($, notesAtom, () => [])
        extra.push(...notes)
      }
    }
    return extra.length > 0 ? { ...ran, context: [...(ran.context ?? []), ...extra] } : ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapAtom)
    if (e.props.hasSurvey || snap === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const eta = await read($, etaAtom)

    const tokens = snap.tokens ?? 0
    const ctxColor = tokens >= 2 * o.contextNudgeTokens ? 'red' : tokens >= o.contextNudgeTokens ? 'yellow' : undefined
    const limColor = (p: number) => (p >= o.hardLimitPercent ? 'red' : p >= o.softLimitPercent ? 'yellow' : undefined)
    // The projection is shown while fresh and only if the block would come before the reset.
    const five = snap.limits.find(l => l.kind === 'five_hour')
    const toReset = five?.resetsAt === undefined ? Infinity : (Date.parse(five.resetsAt) - now) / MIN
    const showEta = eta !== null && now - eta.at <= 10 * MIN && eta.minutes < toReset

    return (
      <Box>
        <Text dimColor={ctxColor === undefined} color={ctxColor}>
          ctx {snap.tokens === undefined ? '–' : k(tokens)}/{k(snap.window)}
        </Text>
        {tracked(snap.limits)
          .filter(l => live(l, now))
          .map(l => {
            // The week is over pace when it would pass 100% before its reset.
            const pace = l.kind === 'seven_day' ? weekPace(l, now) : null
            const color = limColor(l.percentUsed) ?? (pace !== null && pace >= 100 ? 'yellow' : undefined)
            return (
              <Text key={l.kind} dimColor={color === undefined} color={color}>
                {'  ·  '}
                {WINDOWS[l.kind]} {Math.floor(l.percentUsed)}%
                {l.kind === 'five_hour' ? ` → ${hhmm(l.resetsAt)} (${left(l.resetsAt, now)})` : ''}
                {pace !== null ? ` (pace ${Math.round(pace)}%)` : ''}
              </Text>
            )
          })}
        {showEta && eta !== null ? (
          <Text color={eta.minutes <= o.runwayMinutes ? 'red' : 'yellow'}>
            {'  ·  '}
            {o.hardLimitPercent}% in {Math.max(1, Math.round(eta.minutes))}m
          </Text>
        ) : null}
      </Box>
    )
  })
}

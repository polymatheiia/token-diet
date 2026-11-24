// The usage log's pure parts: rows, prices and the fit. No engine calls here.

/** Tokens of one model: input, output, cache read, 5-minute cache write, 1-hour cache write. */
export type Counts = number[]
export type Spent = Record<string, Counts>
/**
 * One log line: when, the two windows as [percent, reset time], context size, tokens since the line
 * before, the session's cost so far in US dollars (/cost's figure: advisor and side calls included),
 * the smallest context size seen so far (what the session started with), and the advisor calls
 * since the line before.
 */
export type Row = { t: number; five?: [number, string]; wk?: [number, string]; ctx?: number; d?: Spent; usd?: number; start?: number; adv?: number }

type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
  model: string
}

export const addUsage = (spent: Spent, u: ApiUsage): Spent => {
  const h1 = u.ephemeral_1h_input_tokens ?? 0
  // A write that names no lifetime is priced as five minutes, as /cost does.
  const m5 = Math.max(0, u.cache_creation_input_tokens - h1)
  const add = [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, m5, h1]
  const held = spent[u.model] ?? [0, 0, 0, 0, 0]
  return { ...spent, [u.model]: add.map((n, i) => n + (held[i] ?? 0)) }
}

export const isEmpty = (spent: Spent) => Object.values(spent).every(c => c.every(n => n === 0))

// API list price: $ per million input tokens and the cache-read multiplier. Output is 5x input,
// cache writes 1.25x (5 minutes) and 2x (1 hour). Only a common scale across models: the
// subscription limit is not billed at these prices.
const PRICES: [RegExp, number, number][] = [
  [/fable-5-2|mythos-5-2/, 8, 0.025],
  [/fable|mythos/, 10, 0.025],
  [/opus-5-5/, 4, 0.05],
  [/opus/, 5, 0.1],
  [/sonnet-5-5/, 2, 0.05],
  [/sonnet/, 2, 0.1],
  [/haiku-5/, 0.1, 0.1],
  [/haiku/, 1, 0.1],
]

/** A model's tokens in API dollars: [everything but cache reads, cache reads]. */
export const dollars = (model: string, c: Counts): [number, number] => {
  const [, price, readX] = PRICES.find(([re]) => re.test(model)) ?? [null, 4, 0.05]
  const [input = 0, output = 0, read = 0, m5 = 0, h1 = 0] = c
  return [(price * (input + 5 * output + 1.25 * m5 + 2 * h1)) / 1e6, (price * readX * read) / 1e6]
}

/** API dollars of the model calls one log line counted, cache reads included. */
const rowDollars = (row: Row) => Object.entries(row.d ?? {}).reduce((n, [model, c]) => n + dollars(model, c).reduce((a, b) => a + b, 0), 0)

/**
 * /cost's growth against what the loop's own model calls logged over the same lines, and the
 * advisor calls among them. Each session's first cost reading is only the baseline (a resumed
 * session's /cost may carry what came before it), and lines after its last reading are left out.
 * Cost restarts at 0 on /clear, so a fall starts a new stretch.
 */
export const outside = (groups: Row[][]) => {
  let cost = 0
  let loop = 0
  let adv = 0
  for (const rows of groups) {
    const first = rows.findIndex(r => r.usd !== undefined)
    let end = -1
    rows.forEach((r, i) => {
      if (r.usd !== undefined) end = i
    })
    if (first < 0 || end <= first) continue
    let last = rows[first]?.usd ?? 0
    for (const r of rows.slice(first + 1, end + 1)) {
      loop += rowDollars(r)
      adv += r.adv ?? 0
      if (r.usd === undefined) continue
      cost += r.usd >= last ? r.usd - last : r.usd
      last = r.usd
    }
  }
  return { cost, loop, adv, rest: Math.max(0, cost - loop) }
}

/** The context size each session started with: its last line's, which holds the smallest seen. */
export const startups = (groups: Row[][]) =>
  groups.map(rows => [...rows].reverse().find(r => r.start !== undefined)?.start).filter((n): n is number => n !== undefined)

const median = (list: number[]) => {
  const s = [...list].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

export const parseRows = (text: string): Row[] => {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as Row
      if (typeof row.t === 'number') rows.push(row)
    } catch {}
  }
  return rows
}

/** One stretch of a 5-hour window: points gained, and what every session spent meanwhile. */
export type Interval = { points: number; fresh: number; read: number }

// Readings of one 5-hour window count in whole points, so a stretch is closed only once it has
// gained this many: a smaller one is mostly rounding.
const MIN_POINTS = 4
// Reset times this close together are one window.
const SAME_WINDOW = 10 * 60_000

/** Cuts the merged rows of all sessions into stretches of each 5-hour window. */
export const intervals = (rows: Row[]): Interval[] => {
  const sorted = [...rows].sort((a, b) => a.t - b.t)
  const out: Interval[] = []
  let window = Number.NEGATIVE_INFINITY
  let base = 0
  let top = 0
  let fresh = 0
  let read = 0
  for (const row of sorted) {
    // Spending is counted against the window open when it was logged.
    for (const [model, c] of Object.entries(row.d ?? {})) {
      const [f, r] = dollars(model, c)
      fresh += f
      read += r
    }
    if (row.five === undefined) continue
    const [p, r] = row.five
    const resets = Date.parse(r)
    // A session that has not heard of the current window yet still reports the one before.
    if (!(resets > window - SAME_WINDOW)) continue
    if (resets > window + SAME_WINDOW) {
      // A new window: its first reading is the base, and nothing spent before it counts.
      window = resets
      base = p
      top = p
      fresh = 0
      read = 0
      continue
    }
    // Sessions report the same window a little apart; only a new high is news.
    if (p <= top) continue
    top = p
    if (top - base >= MIN_POINTS) {
      out.push({ points: top - base, fresh, read })
      base = top
      fresh = 0
      read = 0
    }
  }
  return out
}

export type Fit = {
  n: number
  /** Points of the 5-hour window per API dollar of everything but cache reads. */
  perDollar: number
  /** What a cache-read dollar weighs next to any other dollar: 1 as the API prices it, 0 free. */
  readWeight: number
  /** One standard error of readWeight. */
  readWeightError: number
  /** Share of the points the fit explains. */
  explained: number
}

/** Least squares through the origin of points = a * fresh + b * read. */
export const fit = (list: Interval[]): Fit | null => {
  const n = list.length
  if (n < 3) return null
  let sff = 0
  let srr = 0
  let sfr = 0
  let sfp = 0
  let srp = 0
  let spp = 0
  for (const { points, fresh, read } of list) {
    sff += fresh * fresh
    srr += read * read
    sfr += fresh * read
    sfp += fresh * points
    srp += read * points
    spp += points * points
  }
  const det = sff * srr - sfr * sfr
  if (!(det > 1e-12 * sff * srr) || !(sff > 0)) return null
  const a = (sfp * srr - srp * sfr) / det
  const b = (srp * sff - sfp * sfr) / det
  if (!(a > 0)) return null
  let rss = 0
  for (const { points, fresh, read } of list) rss += (points - a * fresh - b * read) ** 2
  const variance = rss / (n - 2)
  // The error of b alone, carried to the ratio b / a (a's own error is left out: it is the smaller one).
  const readWeightError = Math.sqrt((variance * sff) / det) / a
  return { n, perDollar: a, readWeight: b / a, readWeightError, explained: spp > 0 ? 1 - rss / spp : 0 }
}

// Below these the report gives no weight at all.
export const MIN_INTERVALS = 20
export const MAX_ERROR = 0.35

const money = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`

/** The text of /token-diet-usage. */
export const report = (rows: Row[], files: number, days: number, groups: Row[][] = [], warnStart = 0): string => {
  const list = intervals(rows)
  let fresh = 0
  let read = 0
  const byModel: Record<string, number> = {}
  for (const row of rows) {
    for (const [model, c] of Object.entries(row.d ?? {})) {
      const [f, r] = dollars(model, c)
      fresh += f
      read += r
      byModel[model] = (byModel[model] ?? 0) + f + r
    }
  }
  const total = fresh + read
  const lines = [`token-diet usage log: last ${days} days, ${files} session files, ${rows.length} readings.`]
  const out = outside(groups)
  if (out.cost > 0) {
    lines.push(
      `/cost minus the logged loop: $${out.rest.toFixed(2)} of $${out.cost.toFixed(2)} (${Math.round((100 * out.rest) / out.cost)}%), ` +
        `${out.adv} advisor call${out.adv === 1 ? '' : 's'}, from sessions that logged a cost. The rest is the advisor, summaries and side ` +
        `calls, plus what /cost prices above this log's list prices (long-context premium, fast mode, search fees).`,
    )
  }
  const starts = startups(groups)
  if (starts.length > 0) {
    const med = median(starts)
    const warn = warnStart > 0 && med > warnStart ? ` over the ${Math.round(warnStart / 1000)}k target` : ''
    lines.push(
      `Startup context: median ${Math.round(med / 1000)}k, range ${Math.round(Math.min(...starts) / 1000)}k-${Math.round(Math.max(...starts) / 1000)}k over ${starts.length} sessions${warn}.`,
    )
  }
  if (total === 0) return [...lines, 'No model calls logged yet. The log fills as sessions run with this version.'].join('\n')
  const models = Object.entries(byModel)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 4)
    .map(([model, usd]) => `${model.replace(/^claude-/, '')} ${Math.round((100 * usd) / total)}%`)
    .join(', ')
  lines.splice(
    1,
    0,
    `Spent, at API list prices (a common scale, not a bill): ${money(total)}. ` +
      `Cache reads ${Math.round((100 * read) / total)}%, everything else ${Math.round((100 * fresh) / total)}%. By model: ${models}.`,
  )
  const points = list.reduce((sum, i) => sum + i.points, 0)
  const result = fit(list)
  const enough = result !== null && result.n >= MIN_INTERVALS && result.readWeightError <= MAX_ERROR
  if (!enough) {
    lines.push(
      `How the 5-hour limit weighs cache reads: inconclusive. ${list.length} stretches of ${MIN_POINTS}+ points ` +
        `(${points} points in all); a figure needs ${MIN_INTERVALS} stretches and an error under ±${MAX_ERROR}` +
        (result === null ? '.' : `, and this fit has ±${result.readWeightError.toFixed(2)}.`),
    )
  } else {
    const w = result.readWeight
    const reads = Math.max(0, w) * read
    const share = reads / (fresh + reads)
    lines.push(
      `How the 5-hour limit weighs cache reads: ${w.toFixed(2)} ± ${result.readWeightError.toFixed(2)} of their API price ` +
        `(1 = as the API prices them, 0 = free), from ${result.n} stretches; the fit explains ${Math.round(100 * result.explained)}% of the points.`,
      `At that weight re-reading context is about ${Math.round(100 * share)}% of what the limit counts, ` +
        `and one point of the 5-hour window is about ${money(1 / result.perDollar)} of other spending.`,
      share >= 0.3
        ? 'Reading: clearing context early is worth its friction; keep the nudges and the spawn gate.'
        : share >= 0.1
          ? 'Reading: clearing context helps some; the spawn gate is optional (spawnGateTokens 0 turns it off).'
          : 'Reading: re-reading context barely counts against the limit; the spawn gate and firm nudges cost more than they save (spawnGateTokens 0, a higher contextNudgeTokens).',
    )
  }
  lines.push(
    'Not seen by this log: sessions of another Claude Code profile, other devices, and claude.ai chats on the same plan. ' +
      'Their usage shows up as points with nothing spent and lowers the share explained.',
  )
  return lines.join('\n')
}

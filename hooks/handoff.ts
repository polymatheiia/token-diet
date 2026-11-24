// The handoff file's pure parts: which paths count, what the fork is asked, and how its reply
// becomes a file. No engine calls here.

/** Folders, in this order, that make a project keep one handoff file per session. */
export const HANDOFF_DIRS = ['handoffs', 'handoff']
/** A file name that ends in a session's 8-hex tag. */
export const ID_SUFFIX = /-[0-9a-f]{8}\.md$/
const SECTIONS = ['Goal', 'Done', 'In progress', 'In flight', 'Deliverables', 'Decisions', 'Next']

export const baseName = (path: string) => (path.split('/').pop() ?? path).toLowerCase()

export const isHandoffPath = (path: string, handoffFile: string) => {
  const base = baseName(handoffFile)
  const p = path.toLowerCase()
  return p.endsWith(`/${base}`) || p === base || /(^|\/)[^/]*handoff[^/]*\.md$/.test(p) || /(^|\/)handoffs?\/[^/]+\.md$/.test(p)
}

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
export const brief = (call: Record<string, unknown>) => {
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

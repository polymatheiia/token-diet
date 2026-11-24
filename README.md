# token-diet

> **TL;DR:** A Claude Code mod that stops long sessions from eating your usage limit.
> It **shows** what you spend, **nudges** you to hand off and `/clear` before context gets huge,
> and **saves your work** when you hit the limit.

---

## ⚡ Install

At the prompt of a Claude Code session:

```
/plugin install token-diet --marketplace polymatheiia/token-diet
```

Answer `y` to add the marketplace, pick a scope. That's it.

<details>
<summary>Other ways to install</summary>

- **Shell:** `claude plugin install token-diet --marketplace polymatheiia/token-diet`
- **Desktop app:** + next to the prompt box → Plugins → Add marketplace `polymatheiia/token-diet` → Add plugin.
- **Local checkout (development):** `claude --plugin-dir /path/to/token-diet`

</details>

---

## 🎯 The problem

Long agent sessions waste tokens in three ways:

1. **Huge context, re-read on every call.** The biggest cost by far.
2. **Subagents on a stronger model** than the work needs.
3. **Hitting the limit mid-task**, before the final deliverable is written.

token-diet goes after all three.

---

## 👀 What you'll see: the band

A line above the prompt:

```
ctx 230k/1M · start 24k · 5h 62% → 16:40 (2h05) · wk 41% (pace 87%) · 95% in 12m
```

| Part | Means | Turns yellow / red |
|---|---|---|
| `ctx 230k/1M` | context now / context window | 150k / 300k |
| `start 24k` | what the session started with, before you typed | above 35k |
| `5h 62% → 16:40 (2h05)` | 5-hour window used, resets at 16:40, in 2h05 | 80% / 95% |
| `wk 41%` | weekly window used | 80% / 95% |
| `(pace 87%)` | where the week ends at your average rate so far | yellow from 100% (runs out before the reset) |
| `95% in 12m` | only shown when you're burning fast enough to hit the limit before the reset | always yellow; red within 10 min |

`pace` is hidden for the first 17 hours of the week.

---

## 🪜 What happens as a session grows

Each step kicks in on its own. You don't have to remember anything.

| When | What happens | Change it with |
|---|---|---|
| **Context passes 150k** (and every 150k after) | Toast for you + a hidden note telling Claude to update the handoff and suggest `/clear`. From the 2nd nudge on: *start nothing new, hand off, `/clear` now.* | `contextNudgeTokens` |
| **Context above 300k** | Main session can't start agents until it updates its handoff file with Write or Edit. Asks again every 150k after. Subagents aren't gated. | `spawnGateTokens` (`0` = off) |
| **Limit is <10 min away** at the current burn rate | Claude is told: write the deliverable and the handoff **now**. | `runwayMinutes` (`0` = off) |
| **Usage hits 80%** | Same instruction, mid-turn if needed. | `softLimitPercent` |
| **Usage hits 95%** | 🛑 Every tool call is blocked except reading/writing the handoff. Subagents are told to stop and return what they have. | `hardLimitPercent` |
| **Blocked mid-work, handoff out of date** | token-diet writes the handoff itself, then tells you the resume command. | `autoHandoff` |

<details>
<summary>Fine print: the hard limit</summary>

- Handoff files that stay writable: `HANDOFF.md`, any `*handoff*.md`, files in a `handoff/` or `handoffs/` folder.
- A reading whose window has already reset is ignored.
- The block acts on the last reading, so the tool calls of the response that crossed the limit still run.
- **Cross-session guard:** within 5 points of the hard limit, it also checks other sessions' usage logs (last 15 minutes, window not reset) and takes the highest reading. Sessions share the account's windows, so another one may have seen a newer figure. Needs the usage log. Turn off with `crossSession: false`.
- The runway warning needs a measured burn rate of at least 3 points over 3 minutes.

</details>

<details>
<summary>Fine print: the automatic handoff</summary>

- Runs only when the block stops the main session mid-work **and** the handoff wasn't written in the last 20k tokens of context.
- One tool-less side call over the conversation (`$.model.fork`, read from the prompt cache, about 10–15 seconds).
- The side call sees the conversation up to the step before the last, so the plugin adds the last tool calls to its question.
- It updates a file the session already holds, otherwise writes a new one named with the session's tag (`handoffs/<date>-<topic>-<tag>.md`, or `HANDOFF-<tag>.md` beside an existing `HANDOFF.md`). It never writes a file it doesn't hold.
- The file ends with a line saying it was machine-written.
- If the side call fails or returns nothing, Claude is asked to write the handoff instead.

</details>

---

## 🔁 Always on

- **Subagents run on Sonnet.** Applies to `general-purpose`, `Explore`, `Plan` and `claude` subagents without a model, and any subagent asking for opus/fable.
  - When an explicit opus/fable request is replaced, Claude gets a note (and is told not to retry on a stronger model). You get one toast per turn.
  - **Keeps the strong model when:** your last prompt asks for "opus" or "fable" ("don't use opus" doesn't count), or the agent's type/description contains a word from `keepStrongFor`.
  - Forks are left alone: they always inherit the parent model.
- **One handoff file per session.** With a `handoffs/` (or `handoff/`) folder: `handoffs/<date>-<topic>-<tag>.md`, with the session's own 8-character tag, so parallel sessions never share a file. Elsewhere: `HANDOFF.md`. Every later note names that exact file; a handoff read on resume is updated in place.
- **Skill text cap.** A skill longer than 30000 characters is cut, plus one line saying how much was cut and which file to Read for the rest.
- **Usage log.** Counts only, no content. One file per session in `token-diet/usage/<date>-<tag>.jsonl` inside your Claude Code config folder.

<details>
<summary>Fine print: skill cap and usage log</summary>

**Skill cap**
- A skill with no file is never cut (the rest couldn't be read back). That includes built-ins like claude-api and update-config.
- token-diet's own skills are never cut.
- Applies to every load, not just the first: the `skill.prompt` event doesn't say which conversation or subagent a load is for. The engine already collapses some repeat loads itself.
- `skillBodyMaxChars: 0` turns it off.

**Usage log**
- Each usage reading, plus the tokens every model call used since the one before (subagents included).
- Also the session's `/cost` figure in US dollars (advisor and side calls included) and the startup size.
- `usageLog: false` turns it off.

</details>

---

## 🧰 Commands

| Command | Does |
|---|---|
| `/token-diet-usage [days]` | Report over the last 7 days (or `days`). Shown to you only, adds nothing to context. |
| `/token-diet:slim` | Audits what your profile loads at start against what you actually used, then proposes ranked cuts with backup + rollback. **Changes nothing until you agree.** |
| `/token-diet:handoff` | Writes or updates the handoff (includes an *In flight* section for running agents and peer sessions). |
| `/token-diet:handoff resume <path>` | Picks a handoff up in a fresh session. |

<details>
<summary>What <code>/token-diet-usage</code> reports</summary>

- **Cache-read weight.** How much a cache-read token counts against the 5-hour limit, next to its API price. This decides how much `/clear` saves. Says "inconclusive" until it has 20 stretches of 4+ points and an error under ±0.35.
- **Startup size.** Median and range over sessions, so a plugin or connector that creeps back in shows up. Every reading already includes your first prompt, so a big paste or a resume raises it; a later `/clear` brings it down.
- **Cost outside the loop.** `/cost`'s growth minus the loop's own model calls at list prices, plus the number of advisor calls. The difference is mostly the advisor, summaries and side calls (which the per-call log can't see), plus anything `/cost` prices higher (long-context premium, fast mode, search fees). A session's first reading is only the baseline, so a resumed session's earlier cost is left out.
- **Blind spots:** it can't see usage from another Claude Code profile, another device, or claude.ai chats.

`/token-diet:slim` counts tool, MCP-server, skill and slash-command use in past main-session transcripts with `skills/slim/tool_use.py`.

</details>

---

## ⚙️ Settings

All in `/config`.

| Option | Default | What it controls |
|---|---|---|
| `contextNudgeTokens` | `150000` | Nudge to hand off and `/clear` at every multiple of this |
| `spawnGateTokens` | `300000` | Context size where starting agents needs a fresh handoff (`0` = off) |
| `softLimitPercent` | `80` | Usage % where Claude is told to wrap up |
| `hardLimitPercent` | `95` | Usage % where tools are blocked |
| `runwayMinutes` | `10` | Warn this many minutes before the limit at current burn (`0` = off) |
| `handoffFile` | `HANDOFF.md` | Handoff path (ignored in projects with a `handoffs/` folder) |
| `autoHandoff` | `true` | Write the handoff itself when blocked |
| `usageLog` | `true` | Keep the usage log |
| `crossSession` | `true` | Read other sessions' logs near the hard limit |
| `subagentModel` | `sonnet` | `sonnet`, `haiku` or `off` |
| `keepStrongFor` | *(empty)* | Comma-separated words; matching subagents keep their model |
| `skillBodyMaxChars` | `30000` | Skill text cap (`0` = off) |
| `startupWarnTokens` | `35000` | Startup size shown in yellow above this (`0` = off) |

---

## 🪶 Lean profile checklist

Settings that measured well in one profile. All go in `settings.json`. **Back it up first.**

- [ ] `"bashOutputMaxChars": 8000`: long Bash output goes to a file; Claude gets a preview and the path. (Bash results were 25% of context growth.)
- [ ] `"syncClaudeAiSkills": false`: drops synced claude.ai skills from the start (~3k).
- [ ] `"skillOverrides": {"<skill>": "name-only"}`: for skills you never load.
- [ ] `"permissions": {"deny": ["Artifact", ...]}`: a denied built-in tool leaves context (Artifact alone was 12k), but you lose that feature.
- [ ] `"disableClaudeAiConnectors": true`, or `/mcp` per project: for connectors you don't use.

Not sure which ones? Run `/token-diet:slim`; it ranks them against your own usage.

---

## ⚠️ Already have a `usage-guard.sh` hook?

The cross-session guard replaces it. **Remove it once the band shows up in your sessions.**

Until then, note: settings hooks run beneath this plugin's hooks. A `PreToolUse` hook that denies every tool at the same percentage also denies the handoff write token-diet allows. Either give it the same handoff exemption or set its limit above `hardLimitPercent`.

---

## 🛠️ Develop

```
claude plugin validate .
claude plugin test .
```

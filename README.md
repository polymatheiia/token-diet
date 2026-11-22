# token-diet

A Claude Code mod that cuts the biggest token cost in long agentic sessions: **re-reading a huge context on every call**, plus subagents on a stronger model than the work needs, and usage limits that cut off the final deliverable.

## What it does

- **Band above the prompt**: `ctx 230k/1M · 5h 62% → 16:40 (2h05) · wk 41% (pace 87%) · 95% in 12m`, turning yellow/red at the thresholds. `pace` is the weekly percentage the week would end on at its average rate so far (yellow from 100%: it would run out before the reset; hidden in the first 17 hours of the week). The last part appears when the 5-hour window is burning fast enough to reach the hard limit before it resets.
- **Context nudge**: each time context passes another 150k, a toast for you and a note to Claude (never shown in the transcript) to update the handoff and suggest `/clear`. From the second nudge on the note is firmer: start nothing new, hand off, `/clear` now.
- **Spawn gate (300k)**: above this context size the main session cannot start agents until it has updated its handoff file with Write or Edit. It asks again after each further 150k. Subagents are not gated. `spawnGateTokens: 0` turns it off.
- **Runway warning**: when the 5-hour window would reach the hard limit within 10 minutes at the measured burn rate (at least 3 points over 3 minutes), Claude is told to write the deliverable and the handoff now, whatever the percentage.
- **Soft limit (80%)**: the same instruction at a fixed percentage, mid-turn if needed.
- **Hard limit (95%)**: every tool call is denied except reading/writing a handoff file (`HANDOFF.md`, any `*handoff*.md`, or files in a `handoff/` or `handoffs/` folder). Subagents are told to stop and return what they have. A reading whose window has already reset is ignored. The block acts on the last reading, so the tool calls of the very response that crossed the limit still run.
- **Automatic handoff**: when that block stops the main session mid-work and its handoff was not written within the last 20k tokens of context, the plugin writes it: one tool-less side call over the conversation (`$.model.fork`, read from the prompt cache; about 10–15 seconds), saved as this session's handoff file, and Claude is told to stop and give you the resume command. It updates a file the session already holds, and otherwise writes one named with the session's tag (`handoffs/<date>-<topic>-<tag>.md`, or `HANDOFF-<tag>.md` beside an existing `HANDOFF.md`), never a file it does not hold. The side call sees the conversation up to the step before the last, so the plugin adds the last tool calls to its question; the file ends with a line saying it was machine-written. If the side call fails or returns no handoff, Claude is asked to write it as before. `autoHandoff: false` turns this off.
- **Subagent model**: `general-purpose`, `Explore`, `Plan` and `claude` subagents without a model, and any subagent asking for opus/fable, run on Sonnet. When an explicit opus/fable request is replaced, Claude gets a note saying so (and not to retry on a stronger model) and you get one toast per turn. Exceptions: your last prompt asks for "opus" or "fable" ("don't use opus" does not count), or the agent's type or description contains a word from `keepStrongFor`. Forks are left alone (they always inherit the parent model).
- **One handoff file per session**: in a project with a `handoffs/` (or `handoff/`) folder each session writes `handoffs/<date>-<topic>-<tag>.md`, where the 8-character tag is the session's own, so parallel sessions in one folder never share a file and other documents in that folder are never mistaken for a handoff. Elsewhere it is `HANDOFF.md`. Once written, every later note names that exact file; a handoff read on resume is carried on in place.
- **Usage log**: each usage reading is written, with the tokens every model call of the session (subagents included) used since the reading before, to `token-diet/usage/<date>-<tag>.jsonl` in your Claude Code config folder: counts only, no content, one file per session. **`/token-diet-usage [days]`** merges the files of the last 7 days and fits how much a cache-read token counts against the 5-hour limit next to its API price, which is what decides how much `/clear` saves. It says "inconclusive" until it has 20 stretches of 4+ points and an error under ±0.35, and its output is shown to you only (it adds nothing to context). It cannot see usage from another Claude Code profile, another device, or claude.ai chats. `usageLog: false` turns the log off.
- **Skill text cap**: with `skillBodyMaxChars` set above 0, a skill's text longer than that is cut to its first that-many characters, followed by one line saying how much was cut and the skill file to Read for the rest. Off by default. It applies to every load, because the `skill.prompt` event does not say which conversation or subagent a load is for, so a repeat load in one conversation cannot be told from a first load in another; the engine already collapses some repeat loads itself. token-diet's own skills are never cut.
- **`/token-diet:handoff`** writes or updates the handoff (with an *In flight* section for running agents and peer sessions); `/token-diet:handoff resume <path>` picks it up in a fresh session.

All thresholds are options in `/config`: `contextNudgeTokens`, `spawnGateTokens`, `softLimitPercent`, `hardLimitPercent`, `runwayMinutes`, `handoffFile`, `autoHandoff`, `usageLog`, `subagentModel` (`sonnet` | `haiku` | `off`), `keepStrongFor`, `skillBodyMaxChars`.

### With a settings `PreToolUse` guard

Settings hooks run beneath this plugin's hooks. A `PreToolUse` hook that denies every tool at the same percentage also denies the handoff write this plugin lets through, so give that hook the same handoff exemption or set its limit above `hardLimitPercent`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install token-diet --marketplace polymatheiia/token-diet
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install token-diet --marketplace polymatheiia/token-diet
```

In the desktop app: click + next to the prompt box → Plugins → Add marketplace `polymatheiia/token-diet` → Add plugin.

For development, load a local checkout with `claude --plugin-dir /path/to/token-diet`.

## Develop

```
claude plugin validate .
claude plugin test .
```

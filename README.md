# token-diet

A Claude Code mod that cuts the biggest token cost in long agentic sessions: **re-reading a huge context on every call**, plus subagents on a stronger model than the work needs, and usage limits that cut off the final deliverable.

## What it does

- **Band above the prompt**: `ctx 230k/1M · 5h 62% → 16:40 (2h05) · wk 41% · 95% in 12m`, turning yellow/red at the thresholds. The last part appears when the 5-hour window is burning fast enough to reach the hard limit before it resets.
- **Context nudge**: each time context passes another 150k, a toast for you and a note to Claude (never shown in the transcript) to update the handoff and suggest `/clear`. From the second nudge on the note is firmer: start nothing new, hand off, `/clear` now.
- **Spawn gate (300k)**: above this context size the main session cannot start agents until it has updated its handoff file with Write or Edit. It asks again after each further 150k. Subagents are not gated. `spawnGateTokens: 0` turns it off.
- **Runway warning**: when the 5-hour window would reach the hard limit within 10 minutes at the measured burn rate (at least 3 points over 3 minutes), Claude is told to write the deliverable and the handoff now, whatever the percentage.
- **Soft limit (80%)**: the same instruction at a fixed percentage, mid-turn if needed.
- **Hard limit (95%)**: every tool call is denied except reading/writing a handoff file (`HANDOFF.md`, any `*handoff*.md`, or files in a `handoff/` or `handoffs/` folder). The main session is told to write the handoff; subagents are told to stop and return what they have. A reading whose window has already reset is ignored.
- **Subagent model**: `general-purpose`, `Explore`, `Plan` and `claude` subagents without a model, and any subagent asking for opus/fable, run on Sonnet. When an explicit opus/fable request is replaced, Claude gets a note saying so (and not to retry on a stronger model) and you get one toast per turn. Exceptions: your last prompt asks for "opus" or "fable" ("don't use opus" does not count), or the agent's type or description contains a word from `keepStrongFor`. Forks are left alone (they always inherit the parent model).
- **One handoff file per session**: in a project with a `handoffs/` (or `handoff/`) folder each session writes `handoffs/<date>-<topic>-<tag>.md`, where the 8-character tag is the session's own, so parallel sessions in one folder never share a file and other documents in that folder are never mistaken for a handoff. Elsewhere it is `HANDOFF.md`. Once written, every later note names that exact file; a handoff read on resume is carried on in place.
- **`/token-diet:handoff`** writes or updates the handoff (with an *In flight* section for running agents and peer sessions); `/token-diet:handoff resume <path>` picks it up in a fresh session.

All thresholds are options in `/config`: `contextNudgeTokens`, `spawnGateTokens`, `softLimitPercent`, `hardLimitPercent`, `runwayMinutes`, `handoffFile`, `subagentModel` (`sonnet` | `haiku` | `off`), `keepStrongFor`.

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

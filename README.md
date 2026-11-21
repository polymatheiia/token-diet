# token-diet

A Claude Code mod that cuts the biggest token cost in long agentic sessions: **re-reading a huge context on every call**, plus Opus subagents nobody asked for, and usage limits that cut off the final deliverable.

## What it does

- **Band above the prompt**: `ctx 230k/1M · 5h 62% → 16:40 (2h05) · wk 41%`, turning yellow/red at the thresholds. A clock you can't miss.
- **Context nudge**: each time context passes another 150k, a toast for you and a note to Claude (never shown in the transcript) to update the handoff and suggest `/clear`.
- **Soft limit (80%)**: Claude is told, mid-turn if needed, to write the deliverable and the handoff before anything else.
- **Hard limit (95%)**: every tool call is denied except reading/writing the handoff file (`HANDOFF.md`, any `*handoff*.md`, or files in a `handoff/` folder), so the summary still gets saved.
- **Subagent model**: `general-purpose`, `Explore` and `Plan` subagents without a model, and any subagent asking for opus/fable, run on Sonnet, unless your last prompt names "opus" or "fable". Forks are left alone (they always inherit the parent model).
- **`/token-diet:handoff`** writes or updates the handoff; `/token-diet:handoff resume` picks it up in a fresh session.

All thresholds are options in `/config`: `contextNudgeTokens`, `softLimitPercent`, `hardLimitPercent`, `handoffFile`, `subagentModel` (`sonnet` | `haiku` | `off`).

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

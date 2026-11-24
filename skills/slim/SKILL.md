---
name: slim
description: Audit what this profile loads at session start (built-in tools, plugins, skills, MCP servers, connectors) against what past sessions actually used, and propose a ranked list of cuts with exact settings edits, a backup and a rollback. Use when the user says slim, startup context, "why does every session start so big", or when token-diet warns that the startup size is over its target. Proposes only; changes nothing until the user agrees.
---

# Slim

Goal: lower the context every session starts with, cutting only what past use shows is not needed.

## 1. Measure

1. You cannot run `/context` yourself. Ask the user to run `/context` and paste the output: it gives the startup split by tools, MCP tools, skills, memory files. Read the startup size from the token-diet band (`start Nk`) or ask for `/token-diet-usage`.
2. Run `python3 -I <base directory>/tool_use.py "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" 60`, where `<base directory>` is the path in the "Base directory for this skill:" line above. It prints how often each tool, MCP server and skill was used in the last 60 days of main-session transcripts. `skills` counts Skill tool loads; `slash_commands` counts typed commands, and a command named after a skill is a load of that skill, so add the two.
3. Read the profile's `settings.json` (`enabledPlugins`, `permissions.deny`, `skillOverrides`, `env`) and `claude mcp list`, `claude plugin list`.

## 2. Rank

For each loaded item give: startup cost (from `/context`; an estimate only when marked so), calls in 60 days, certainty. Cut candidates, in order of evidence:
- Built-in tools never or rarely used: a `permissions.deny` entry removes the tool from context (verified: denied tools are missing from the request), but also removes the feature. Say what is lost.
- Skills with 0 loads: `skillOverrides` `{name: "name-only"}` (not for plugin skills). Plugin skills: disable the plugin.
- Plugins and MCP servers with 0 to a few calls: `claude plugin disable`, `claude mcp remove`, per-project `/mcp` toggle.
- Connectors: `disableClaudeAiConnectors`, or per-project.

Never recommend cutting something with many calls only because it is large; give the "start it on demand" route instead (e.g. `claude --chrome`). Items the user chose to keep earlier in this conversation stay.

## 3. Propose, then apply

Show the ranked table with calls and savings, then ask which to apply. For each applied change: copy `settings.json` (and `.claude.json` if touched) to `<name>.bak-<timestamp>` first, apply, verify with the real CLI (`claude plugin list`, `claude mcp list`), and print the exact rollback command. Close other sessions of the profile before restoring `.claude.json`.

After applying, tell the user to start a fresh session and compare the `start` figure in the band with the estimate.

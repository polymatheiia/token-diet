---
name: handoff
description: Write or update the session handoff file (default HANDOFF.md) so work can continue in a fresh session after /clear or a usage-limit hit. Use when the user says handoff, wrap up, save state, or when a token-diet note asks for it. With argument "resume", read the newest handoff and continue from it.
---

# Handoff

Goal: a fresh session with zero context can continue from this file alone. Keep it under ~60 lines; it is re-read on resume.

## Write / update (default)

1. If the file exists, read it and **update in place** — don't append a second copy.
2. Sections, terse bullets, concrete identifiers (paths, branches, PR/task numbers, commands):
   - **Goal** — one line: what this work is for.
   - **Done** — what is finished and verified (with evidence: test run, commit SHA).
   - **In progress** — branch/worktree, last commit, what's half-done, exact next command.
   - **Deliverables** — anything the user asked for that exists only in this conversation (report text, summary, numbers): paste it here or into its own file and link it. Never leave it only in context.
   - **Decisions** — choices made and pending questions for the user.
   - **Next** — ordered next steps, first one small.
3. Don't run tests, reproductions or polish before writing — handoff first, verification after.
4. Reply with one line: the path, and "safe to /clear; resume with `/token-diet:handoff resume`".

## Resume (argument `resume`)

1. Read the handoff file (newest one if there are several under a `handoff/` folder).
2. Check drift cheaply: `git status -sb`, `git log -3 --oneline` on the named branches. Don't re-read files the handoff already summarises.
3. Report in ≤5 lines: where things stand, any drift, the first next step. Then do it.

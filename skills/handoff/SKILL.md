---
name: handoff
description: Write or update this session's handoff file so work can continue in a fresh session after /clear or a usage-limit hit. Use when the user says handoff, wrap up, save state, or when a token-diet note asks for it. With argument "resume" (optionally followed by a path), read a handoff and continue from it.
---

# Handoff

Goal: a fresh session with zero context can continue from this file alone. Keep it under ~60 lines; it is re-read on resume.

## Which file

The line `[token-diet] This session's handoff file: …` at the end of this prompt names it. Use exactly that path; where it contains `<topic>`, replace that with a 2-4 word slug and keep the 8-character tag at the end, which is what keeps parallel sessions in one folder apart. If that line is missing, use the path a token-diet note or denial gave you in this conversation; failing that, `HANDOFF.md` in the working folder, or in a project with a `handoffs/` folder a new `handoffs/<YYYY-MM-DD>-<topic>.md`, and tell the user the line was missing. Never write into another session's handoff file, and when the line is present never use a file without that tag in a `handoffs/` folder: specs, reports and logs live there too.

## Write / update (default)

1. If the file exists, read it and **update in place** with Write or Edit — don't append a second copy, and don't write it through Bash (token-diet only sees Write and Edit).
2. Sections, terse bullets, concrete identifiers (paths, branches, PR/task numbers, commands):
   - **Goal** — one line: what this work is for.
   - **Done** — what is finished and verified (with evidence: test run, commit SHA).
   - **In progress** — branch/worktree, last commit, what's half-done, exact next command.
   - **In flight** — everything still running or owned elsewhere: background agents (name or id, task, where its result lands), peer sessions (name, what each owns, what it is waiting for), scheduled wakeups, long-running commands. "None" if nothing.
   - **Deliverables** — anything the user asked for that exists only in this conversation (report text, summary, numbers): paste it here or into its own file and link it. Never leave it only in context.
   - **Decisions** — choices made and pending questions for the user.
   - **Next** — ordered next steps, first one small.
3. Don't run tests, reproductions or polish before writing — handoff first, verification after.
4. Reply with one line: the path, and "safe to /clear; resume with `/token-diet:handoff resume <path>`" with the real path filled in.

## Resume (argument `resume [path]`)

1. With a path: read that file. Without one: list the handoff files here (`HANDOFF.md` and any `HANDOFF-<tag>.md` beside it, or the files in `handoffs/` whose names end in an 8-character tag), newest first, show the user up to five with their Goal lines, and ask which one. Don't pick one yourself, and don't take the newest file in the folder for a handoff.
2. Check drift cheaply: `git status -sb`, `git log -3 --oneline` on the named branches, and whether anything under **In flight** has finished. Don't re-read files the handoff already summarises.
3. Report in ≤5 lines: where things stand, any drift, the first next step. Then do it. Keep updating the same file from here on.

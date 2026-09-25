---
name: splitbrief-dev
description: Use at the start of any SPLITBRIEF development session. Load project conventions before touching the codebase.
---

# SPLITBRIEF development context

Read **`CLAUDE.md`** first. It is the single source of truth for stack, commands, documentation map, and core conventions.

Before changing a subsystem, follow the matching doc linked from the **Documentation map** in `CLAUDE.md`.

**Do not run `git add`, `git stage`, or `git commit`.** The user reviews and commits manually.

When the work is to be built by SPLITBRIEF itself (the built CLI on this repo), follow `docs/DOGFOODING.md`: fix a tool defect mid-run, rebuild, `continue` the same session.

For a supervised run that stops and fixes tool defects before continuing, use [splitbrief-babysit](../../skills/splitbrief-babysit/SKILL.md).

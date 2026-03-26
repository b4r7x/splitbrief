# What to Work on Next

**Last updated**: 2026-03-26
**Branch**: `006-conversational-planning`
**Context**: Load `/tiny-spec-dev` skill first, then read this file.

## What Just Happened

We implemented 47 tasks across 8 phases on branch `006-conversational-planning`. The goal was: interactive TUI picker, conversational planning with clarifications, shell subprocess implementer, codebase cleanup, and constitution update.

Everything was implemented and tests pass (227 tests, 0 failures). But when we actually ran it, we discovered problems.

## Problems Discovered

### 1. Shell implementer doesn't work for agent-style tools

We built `implementer.type: shell` to allow custom commands as the implementer (like the shell planner). The idea: user configures their bash wrapper (e.g., `claude-zai` which is Claude Code pointed at Z.AI's GLM models) as the implementer.

**Why it doesn't work**:
- `spawn()` can't see bash functions — only executables on PATH. `claude-zai` is a bash function, not a script.
- Even if it were a script, agent-style tools (like Claude Code) manage their own files. But tiny-spec assumes it controls file writes via `extractCode()` → `applyCode()`. Two things writing to the same files = conflict.
- The stdin/stdout contract (prompt in, code out) is too simple for tools that use streaming JSON, sessions, tool use, etc.

**The deeper question**: Decision #5 in docs/VISION.md says "Don't wrap agents in agents." But users WANT to use agent-style tools as implementers. This is a design tension that needs resolving.

**Possible directions**:
- **Agent mode**: New `implementer.type: agent` where the implementer manages its own files. Tiny-spec only does: send task description → wait for completion signal → validate (tsc/lint/test) → commit. No `extractCode()`, no `applyCode()`. The implementer is trusted to write files.
- **Keep it simple**: Only support "dumb" implementers (OpenAI API, simple scripts). If you want an agent, use it directly, don't put it behind tiny-spec.
- **Hybrid**: Default is dumb mode. Agent mode is opt-in with clear warnings that validation may not catch everything.

### 2. Interactive TUI not battle-tested

The conversational planning flow was implemented by AI agents in one pass. It hasn't been tested end-to-end with real Claude Code + real Ollama. Specifically:
- Question asking flow (does the planner actually emit `<!-- Q:{JSON} -->` markers?)
- Comment-on-approval flow (does regeneration work within the same session?)
- File persistence (are clarifications written to spec.md correctly?)
- Edge cases: what if planner outputs malformed questions? What if user cancels mid-question?

**What to do**: Run `npm run dev -- start "add user authentication"` end-to-end with Claude Code as planner and Ollama as implementer. Fix whatever breaks.

### 3. Claude Code CLI compatibility

v2.1.84 requires `--verbose` flag for `stream-json` + `-p`. We fixed it, but the API is a moving target. We should consider:
- Version detection at startup (`claude --version` → parse → adjust flags)
- Graceful error messages when Claude Code's output format changes

## Priority Order

1. **Decide on agent-mode implementer** — this blocks everything else because it determines the architecture
2. **Battle-test the conversational flow** — run it for real, fix what breaks
3. **Fix CLI compatibility** — add version detection or at least better error messages
4. **Then**: token dashboard, integration tests, multi-language support

## Key Files to Understand

| File | What it does | Why it matters |
|------|-------------|---------------|
| `src/orchestrator/orchestrator.ts` | Main workflow loop (~700 lines) | All flow logic lives here — question loop, approval loop, retry/escalation |
| `src/orchestrator/planners/claude-code.ts` | Claude Code subprocess planner | Spawns `claude -p`, parses stream-json, extracts questions |
| `src/orchestrator/implementer.ts` | Implementer dispatch | Routes to OpenAI API or shell based on `config.implementer.type` |
| `src/orchestrator/implementers/shell.ts` | Shell subprocess implementer | The problematic stdin/stdout model |
| `src/orchestrator/question-parser.ts` | Question extraction | Parses `<!-- Q:{JSON} -->` from planner stream |
| `src/tui/prompt.tsx` | Approval prompt | approve/edit/comment/quit |
| `src/tui/picker.tsx` | Planner/implementer picker | Auto-detect and select |
| `src/tui/question-prompt.tsx` | Question display | Shows choices, accepts answers |
| `src/app.tsx` | Root TUI component | Wires everything together — state, callbacks, overlays |
| `src/spec/templates.ts` | Planner prompts | Research, spec, plan, tasks, regenerate — all prompt templates |
| `docs/VISION.md` | Strategic direction | What we are, what we're NOT, known problems, competitive landscape |
| `.specify/memory/constitution.md` | Constitutional principles | 6 principles including anti-goals (v1.1.0) |

## Conversation History Summary

The owner's intent: tiny-spec should be a **cost-optimizer**, not a universal connector. The unique value is the planner/implementer split with validation, retry, and escalation. No other tool does this.

The owner uses Claude Code (normal) as planner and wants flexibility in the implementer — including using claude-zai (Claude Code + Z.AI's GLM models) or any other tool. The current `type: shell` approach was too simplistic and needs rethinking.

The interactive TUI (picker, conversational questions, comment-on-approval) is the right direction but needs real-world testing before it's trustworthy.

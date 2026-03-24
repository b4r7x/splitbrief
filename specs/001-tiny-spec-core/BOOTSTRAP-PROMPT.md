# Bootstrap Prompt for Implementing tiny-spec

> **Copy everything below this line and paste it as the first message in a new AI context (Claude Code, OpenCode, or any AI coding tool). The AI will have everything it needs to implement the project.**

---

# TASK: Implement tiny-spec v0.1

You are implementing an open-source CLI tool called **tiny-spec**. The project has a complete specification, plan, and task list. Your job is to implement everything following the tasks exactly.

## What is tiny-spec?

A TypeScript CLI tool that orchestrates two AI coding sessions:
- **Planner**: Claude API (Opus) — researches codebase, writes specs, plans, tasks, validates
- **Implementer**: Local model via Ollama/LM Studio (OpenAI-compatible API) — implements tasks one by one

The tool shows a split-pane terminal UI (like tmux) using Ink. Left pane shows planner activity, right pane shows implementer activity. Bottom bar shows progress.

**The goal**: Use $100/mo Claude plan for thinking, free local models for typing. Effective 2-3x value multiplier.

## Project Setup

Working directory: The current directory (should be empty or near-empty).

Initialize with:
```bash
npm init -y
```

Then follow the tasks below.

## Implementation Documents

Read these files in order before starting:
1. `specs/001-tiny-spec-core/spec.md` — Requirements and acceptance criteria
2. `specs/001-tiny-spec-core/plan.md` — Architecture, dependencies, file structure
3. `specs/001-tiny-spec-core/tasks.md` — 33 tasks across 9 phases (implement in order)
4. `CLAUDE.md` — Code conventions and quick reference

## Key Architecture Decisions

1. **API-direct approach (not subprocess orchestration)**: Use `@anthropic-ai/sdk` for Claude API calls and `openai` SDK pointing to Ollama/LM Studio for local model calls. Do NOT spawn Claude Code or OpenCode as subprocesses — call their APIs directly.

2. **Ink for TUI**: Use Ink (React for CLI) with `<Box flexDirection="row">` for the split-pane layout. Not actual tmux — it's a React-based terminal app.

3. **State machine**: The workflow progresses through phases. State is persisted to `.tiny-spec/current/state.json` so interrupted workflows can resume.

4. **Self-contained task prompts**: When sending a task to the local model, the prompt must contain ALL context inline. Never tell the model to "go read a file" — paste the relevant code into the prompt.

5. **Validation pipeline**: After each task, run tsc → lint → test. On failure, format the error and retry with the local model (max 3 times), then escalate to Claude.

6. **Whole-file format for small models**: When the local model implements a task, ask it to return the complete file content. Don't use diffs or search/replace — small models (7-9B) are most reliable with whole-file output.

## Tech Stack

- Node.js 22+ (native TypeScript stripping via `--experimental-strip-types`)
- TypeScript 5.9+ strict, ESM only (`"type": "module"`)
- Ink 5.x + @inkjs/ui 2.x + React 18.x
- `@anthropic-ai/sdk` for Claude API
- `openai` SDK for OpenAI-compatible local models (Ollama, LM Studio)
- `yaml` for config parsing
- `simple-git` for git operations
- `commander` for CLI

## Code Conventions

- Zero classes — pure functions only, module-scoped state
- ESM imports with `.js` extension: `import { x } from './foo.js'`
- No unnecessary comments
- JSX in `.tsx` files, logic in `.ts` files
- Error handling at boundaries only
- Dev mode: `node --experimental-strip-types src/cli.ts`

## How to Start

1. Read `specs/001-tiny-spec-core/tasks.md`
2. Start with Phase 1 (T001-T006): project setup
3. Continue phase by phase, task by task
4. Tasks marked `[P]` within a phase can be done in parallel
5. Mark each task as `[x]` in tasks.md when done

## Provider Configuration Examples

```typescript
// Ollama
import OpenAI from 'openai';
const ollama = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
});

// LM Studio
const lmstudio = new OpenAI({
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'lm-studio',
});

// Claude (for planning)
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic();  // uses ANTHROPIC_API_KEY env var
```

## Expected Final Result

After implementation, the user should be able to:

```bash
# Install
npm install -g tiny-spec

# Initialize in a project
cd my-project
tiny-spec init
# → Creates .tiny-spec/config.yaml with detected local models

# Run full workflow
tiny-spec start "add user authentication with JWT"
# → Opens split-pane TUI
# → Left pane: Claude (Opus) researches codebase, writes spec, plan, tasks
# → User reviews and approves spec
# → Right pane: Local model implements tasks one by one
# → Automated validation after each task
# → Failed tasks escalate to Opus
# → Final Opus review of all changes
# → Summary: "12 tasks complete, 2 escalated, 0 failed"

# Or just generate specs
tiny-spec spec "add rate limiting to API endpoints"
# → Generates .tiny-spec/current/spec.md, plan.md, tasks.md
```

## GO

Start implementing now. Begin with Phase 1, Task T001.

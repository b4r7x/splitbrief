# Execute Prompt: RPC Mode

## Prompt To Paste

```text
You are implementing bidirectional RPC mode for diptych:

docs/superpowers/specs/04-rpc-mode/

Goal:
Extend --json headless mode into --rpc with bidirectional NDJSON. Stdin accepts commands (approve, reject, message, recovery, status, abort, slash). Stdout emits EngineEvents. This lets external tools drive diptych programmatically.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.
- Zod 4.x, Vitest 4.x, Biome 2.x.

Required skills to load BEFORE writing any code:
1. /sota
2. /code-audit
3. /test-behavior-not-implementation
4. /clean-code
5. /api-patterns — for protocol design

Required reading:
1. CLAUDE.md
2. docs/CLI-REFERENCE.md
3. docs/ARCHITECTURE.md
4. src/cli/headless.ts — current --json mode (111 lines)
5. src/cli/commands/start.ts — --json routing
6. src/cli/options.ts — CLI option definitions
7. src/engine/events/types.ts — EngineEvent union (~70 types), EventBus
8. src/core/schemas/workflow.ts — WorkflowState, messageQueue, pendingRecovery
9. src/engine/orchestrator/recovery/actions.ts — recovery action handling
10. src/core/slash-commands/dispatch.ts — slash command execution

Implementation order:
1. docs/superpowers/specs/04-rpc-mode/agent-briefs/01-protocol-types.md
2. docs/superpowers/specs/04-rpc-mode/agent-briefs/02-rpc-runner.md

After done: npm run test-ci + verify --json unchanged + --rpc accepts commands.
```

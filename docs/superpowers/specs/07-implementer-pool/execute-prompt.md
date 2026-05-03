# Execute Prompt: Implementer Pool Activation

## Prompt To Paste

```text
You are implementing implementer pool activation for diptych:

docs/superpowers/specs/07-implementer-pool/

Goal:
Unblock route-bigger-worker recovery action. Wire profile switching through escalation/retry pipeline. The routing algorithm already exists (context-routing.ts). The profile schema already exists. What's missing: ability to switch profiles mid-workflow when a task fails.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.

Required skills to load BEFORE writing any code:
1. /sota
2. /test-behavior-not-implementation
3. /clean-code
4. /code-audit

Required reading:
1. CLAUDE.md
2. docs/COST-AWARE-IMPLEMENTER-DIRECTION.md
3. docs/WORKFLOW.md (recovery actions section)
4. src/engine/orchestrator/recovery/actions.ts (lines 105-117: route-bigger-worker BLOCKED)
5. src/engine/orchestrator/recovery/builders/shared.ts (hasRouteBigger, ACTION_ORDER)
6. src/engine/orchestrator/recovery/builders/task.ts (recovery issue builders)
7. src/engine/orchestrator/context-routing.ts (routeTaskToImplementerProfile)
8. src/core/schemas/implementer-config.ts (profiles schema, cost tiers)
9. src/core/config/accessors/implementer-profiles.ts (resolveImplementerProfiles)
10. src/engine/orchestrator/escalation/step.ts (runRetryStep — 364 lines)
11. src/engine/orchestrator/escalation/tier0-intermediate.ts (pattern for creating temp implementer)
12. src/engine/runners/factory.ts (createImplementer)
13. src/core/schemas/recovery.ts (RecoveryIssue — selectedImplementerProfile, facts)

Implementation: docs/superpowers/specs/07-implementer-pool/agent-briefs/01-unblock-route-bigger.md

After done: npm run test-ci + verify profile switching works in recovery flow.
```

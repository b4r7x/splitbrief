# Core Layer SOTA Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL:** Do NOT run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files. Leave every change as an unstaged modification. This overrides any other instruction.

**Goal:** Bring `src/core/` to full SOTA compliance with all project rules documented in CLAUDE.md, PRINCIPLES.md, LAYERS.md, TYPES.md, TESTING.md, and STRUCTURE.md.

**Architecture:** Surgical fixes organized by independence — structural moves first, then type placement, code quality, test cleanup, and minor fixes. Each task is self-contained with no cross-task dependencies unless explicitly noted.

**Tech Stack:** TypeScript 6.x, Vitest 4.x, Zod 4.x, ESM with `.js` imports

**Verification:** After all tasks, run `npm run test-ci` (typecheck + lint + test). All must pass.

---

## Parallel groups

Tasks within the same group are independent and can be dispatched to subagents in parallel. Groups must be executed sequentially (Group 1 before Group 2, etc.).

- **Group 1 (structural):** Tasks 1, 2, 3 (independent)
- **Group 2 (type placement):** Tasks 4, 5 (independent, but after Group 1)
- **Group 3 (code quality):** Tasks 6, 7, 8, 9 (independent)
- **Group 4 (test cleanup):** Tasks 10, 11, 12, 13 (independent)
- **Group 5 (minor fixes):** Tasks 14, 15, 16, 17, 18, 19 (independent)
- **Group 6 (revalidation):** Task 20

---

## Task 1: Move `core/features/cost-chrome.ts` to `core/layout/`

**Why:** `core/features/` creates a false parallel with `src/features/` (vertical business slices). The file has a single consumer (`core/layout/renderable-conversation.ts`) and contains pure cost-prediction row-count math. Per screaming architecture, it belongs in `core/layout/`.

**Files:**
- Move: `src/core/features/cost-chrome.ts` → `src/core/layout/cost-chrome.ts`
- Modify: `src/core/layout/renderable-conversation.ts:5`
- Delete: `src/core/features/` (directory becomes empty)

- [ ] **Step 1: Move the file**

```bash
mv src/core/features/cost-chrome.ts src/core/layout/cost-chrome.ts
rm -rf src/core/features
```

- [ ] **Step 2: Update the import in renderable-conversation.ts**

In `src/core/layout/renderable-conversation.ts`, change line 5:

```ts
// OLD
import { getCostPredictionCardRowCount } from '../features/cost-chrome.js';

// NEW
import { getCostPredictionCardRowCount } from './cost-chrome.js';
```

- [ ] **Step 3: Search for any other consumers**

```bash
rg "from.*features/cost-chrome" src/
```

Expected: zero matches after the edit.

- [ ] **Step 4: Verify**

```bash
npm run typecheck
```

Expected: PASS with zero errors.

---

## Task 2: Fix `simple-git` import in `core/readiness/collect.ts`

**Why:** LAYERS.md explicitly states "No `simple-git` imports outside `src/lib/git.ts`". `collect.ts` imports `simpleGit` directly. The fix: add a `getGitStatus` wrapper to `lib/git.ts`, then use it in `collect.ts`.

**Files:**
- Modify: `src/lib/git.ts` (add export)
- Modify: `src/core/readiness/collect.ts:3,165` (replace direct import)

- [ ] **Step 1: Read `src/lib/git.ts` to understand the pattern**

The file already uses `const getGit = (dir: string): SimpleGit => simpleGit(dir)` internally. Every exported function wraps `simpleGit` calls.

- [ ] **Step 2: Add `getGitStatus` to `lib/git.ts`**

Add after the existing `isGitRepo` function (after line 33):

```ts
export async function getGitStatus(dir: string): Promise<{
  files: Array<{ path: string }>;
  not_added: string[];
}> {
  try {
    return await getGit(dir).status();
  } catch (err) {
    throw toGitCommandError('status', err);
  }
}
```

- [ ] **Step 3: Update `collect.ts` — remove `simple-git` import**

In `src/core/readiness/collect.ts`, replace line 3:

```ts
// OLD
import { simpleGit } from 'simple-git';

// NEW (no replacement line — just remove it)
```

- [ ] **Step 4: Update `collect.ts` — update the git import**

In `src/core/readiness/collect.ts`, change line 7:

```ts
// OLD
import { isGitRepo } from '../../lib/git.js';

// NEW
import { isGitRepo, getGitStatus } from '../../lib/git.js';
```

- [ ] **Step 5: Update `readRepoPosture` to use the wrapper**

In `src/core/readiness/collect.ts`, change line 165:

```ts
// OLD
  const status = await simpleGit(projectDir).status();

// NEW
  const status = await getGitStatus(projectDir);
```

- [ ] **Step 6: Verify no `simple-git` imports remain outside `lib/git.ts`**

```bash
rg "from 'simple-git'" src/ --glob '!src/lib/git.ts' --glob '!*.test.ts'
```

Expected: zero matches.

- [ ] **Step 7: Verify**

```bash
npm run typecheck
```

Expected: PASS.

---

## Task 3: Remove duplicate `canonicalJson` from `core/hooks/trust.ts`

**Why:** `src/utils/canonical-json.ts` already exports `canonicalJSON`. `trust.ts` has its own local implementation — duplicate code (DRY violation).

**Files:**
- Modify: `src/core/hooks/trust.ts:11-17,20` (remove local function, add import, update call)

- [ ] **Step 1: Read both implementations to confirm compatibility**

`utils/canonical-json.ts` exports `canonicalJSON(value: unknown): string` with the same sorted-keys behavior. The local `canonicalJson` in `trust.ts` is a simpler version but produces the same output for the inputs used by `hashHooksConfig`.

**Important:** The util version is named `canonicalJSON` (uppercase JSON), the local one is `canonicalJson` (lowercase). Make sure to use the correct casing.

- [ ] **Step 2: Remove local function and add import**

In `src/core/hooks/trust.ts`, remove lines 11-17 (the local `canonicalJson` function):

```ts
// REMOVE THIS:
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
```

Add an import at the top:

```ts
import { canonicalJSON } from '../../utils/canonical-json.js';
```

- [ ] **Step 3: Update `hashHooksConfig` to use the imported function**

In `src/core/hooks/trust.ts`, update the `hashHooksConfig` function:

```ts
// OLD
  const json = canonicalJson(hooks ?? null);

// NEW
  const json = canonicalJSON(hooks ?? null);
```

- [ ] **Step 4: Run the existing trust test**

```bash
npx vitest run src/core/hooks/trust.test.ts
```

Expected: all tests PASS. Hash values should be identical since both implementations produce the same canonical JSON for the same inputs.

- [ ] **Step 5: If tests fail due to hash mismatch**

This means the implementations differ for some edge case. If so, keep the local function and instead document in a comment why the utils version is not used. But based on reading both, they should be compatible for non-edge-case object inputs.

---

## Task 4: Move `core/types/workflow-events.ts` to `engine/orchestrator/`

**Why:** Fan-in 4, all consumers in `engine/` only. The three-case rule requires fan-in >30 and ≥3 top-level folders for `core/types/`. These types are engine-internal concepts.

**NAMING:** The file is named `workflow-events.ts` (not `workflow-event-types.ts`). TYPES.md bans the `*-types.ts` suffix — "Suffix duplicates the folder's domain."

**Files:**
- Move: `src/core/types/workflow-events.ts` → `src/engine/orchestrator/workflow-events.ts`
- Modify: All consumer imports (4 files in engine/ + re-exports)

**Consumers (from grep):**
1. `src/engine/orchestrator/context-routing.ts:12-13`
2. `src/engine/orchestrator/user-edit/conflicts.ts:5-6`
3. `src/engine/orchestrator/task/review.ts:11-12`
4. `src/engine/events/types.ts:7-9`

- [ ] **Step 1: Move the file**

```bash
mv src/core/types/workflow-events.ts src/engine/orchestrator/workflow-events.ts
```

- [ ] **Step 2: Update internal imports within the moved file**

In `src/engine/orchestrator/workflow-events.ts`, the file imports from `core/schemas/`. Update the relative paths:

```ts
// OLD
import type { TaskId } from '../schemas/task.js';
import type { RecoveryReason, TaskStatus } from '../schemas/enums.js';
import type { TokenUsage, TaskTokenUsage } from '../schemas/tokens.js';

// NEW
import type { TaskId } from '../../core/schemas/task.js';
import type { RecoveryReason, TaskStatus } from '../../core/schemas/enums.js';
import type { TokenUsage, TaskTokenUsage } from '../../core/schemas/tokens.js';
```

- [ ] **Step 3: Update consumer imports**

In `src/engine/orchestrator/context-routing.ts`, update lines 12-13:

```ts
// OLD
export type { TaskContextFit, CurrentCodeContextMode } from '../../core/types/workflow-events.js';
import type { TaskContextFit, CurrentCodeContextMode } from '../../core/types/workflow-events.js';

// NEW
export type { TaskContextFit, CurrentCodeContextMode } from './workflow-events.js';
import type { TaskContextFit, CurrentCodeContextMode } from './workflow-events.js';
```

In `src/engine/orchestrator/user-edit/conflicts.ts`, update lines 5-6. This file is inside `engine/orchestrator/user-edit/`, so the relative path to `engine/orchestrator/workflow-events.ts` is `../`:

```ts
// OLD
export type { UserEditConflictKind, UserEditConflictAction, UserEditConflictFile, UserEditConflict } from '../../../core/types/workflow-events.js';
import type { UserEditConflictKind, UserEditConflictAction, UserEditConflictFile, UserEditConflict } from '../../../core/types/workflow-events.js';

// NEW
export type { UserEditConflictKind, UserEditConflictAction, UserEditConflictFile, UserEditConflict } from '../workflow-events.js';
import type { UserEditConflictKind, UserEditConflictAction, UserEditConflictFile, UserEditConflict } from '../workflow-events.js';
```

In `src/engine/orchestrator/task/review.ts`, update lines 11-12. This file is inside `engine/orchestrator/task/`, so the path is `../`:

```ts
// OLD
export type { TaskReviewStatus, TaskReviewCommand, TaskReviewAction, TaskReviewValidation, TaskReviewRequest, TaskReviewResponse } from '../../../core/types/workflow-events.js';
import type { TaskReviewRequest, TaskReviewValidation } from '../../../core/types/workflow-events.js';

// NEW
export type { TaskReviewStatus, TaskReviewCommand, TaskReviewAction, TaskReviewValidation, TaskReviewRequest, TaskReviewResponse } from '../workflow-events.js';
import type { TaskReviewRequest, TaskReviewValidation } from '../workflow-events.js';
```

In `src/engine/events/types.ts`, update lines 7-9. This file is inside `engine/events/`, so the path is `../orchestrator/`:

```ts
// OLD
import type { UserEditConflict, UserEditConflictAction } from '../../core/types/workflow-events.js';
import type { CurrentCodeContextMode, TaskContextFit } from '../../core/types/workflow-events.js';
import type { TaskReviewRequest } from '../../core/types/workflow-events.js';

// NEW
import type { UserEditConflict, UserEditConflictAction } from '../orchestrator/workflow-events.js';
import type { CurrentCodeContextMode, TaskContextFit } from '../orchestrator/workflow-events.js';
import type { TaskReviewRequest } from '../orchestrator/workflow-events.js';
```

- [ ] **Step 4: Search for any missed consumers**

```bash
rg "core/types/workflow-events" src/ testing/
```

Expected: zero matches.

- [ ] **Step 5: Verify**

```bash
npm run typecheck
```

Expected: PASS.

---

## Task 5: Inline `core/types/summary.ts` types into their producers

**Why:** Fan-in 12, all consumers in `engine/` (plus one in `testing/helpers/`). Does not meet the >30 fan-in, ≥3 folder threshold. Per the three-case rule, types go with their producer.

**Strategy:** TYPES.md bans `*-types.ts` suffix files. Instead of creating a new file, inline each type into the existing file that produces it:
- `ImplementerResult` → `src/engine/implementers/types.ts` (already exists, already imports it)
- `ValidationResult` → `src/engine/orchestrator/validation.ts` (its producer)

Then delete `src/core/types/summary.ts`.

**Files:**
- Delete: `src/core/types/summary.ts`
- Modify: `src/engine/implementers/types.ts` (add `ImplementerResult` inline)
- Modify: `src/engine/orchestrator/validation.ts` (add `ValidationResult` inline + re-export)
- Modify: All 13 consumer imports

**Consumers (from grep):**
`ImplementerResult` consumers:
1. `src/engine/implementers/types.ts:4` — will hold the type itself
2. `src/engine/implementers/base.ts:5` — change to import from `./types.js`

`ValidationResult` consumers:
3. `src/engine/orchestrator/validation.ts:5` — will hold the type itself
4. `src/engine/orchestrator/validation.test.ts:5`
5. `src/engine/orchestrator/events.ts:6`
6. `src/engine/orchestrator/task/commit.ts:4`
7. `src/engine/orchestrator/task/retry.ts:4`
8. `src/engine/orchestrator/recovery/builders/task.ts:4`
9. `src/engine/orchestrator/recovery/builders/shared.ts:4`
10. `src/engine/orchestrator/evidence/persistence.ts:17`
11. `src/engine/orchestrator/evidence/evidence.ts:5`
12. `src/engine/orchestrator/evidence/evidence.test.ts:19`
13. `testing/helpers/orchestrator-factories.ts:2`

- [ ] **Step 1: Add `ImplementerResult` to `engine/implementers/types.ts`**

In `src/engine/implementers/types.ts`, add the type and its import. Replace line 4:

```ts
// OLD
import type { ImplementerResult } from '../../core/types/summary.js';

// NEW (inline the type + add TokenDelta import)
import type { TokenDelta } from '../../core/schemas/tokens.js';

export interface ImplementerResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  usage?: TokenDelta | undefined;
}
```

- [ ] **Step 2: Add `ValidationResult` to `engine/orchestrator/validation.ts`**

In `src/engine/orchestrator/validation.ts`, replace line 5:

```ts
// OLD
import type { ValidationResult } from '../../core/types/summary.js';

// NEW (inline the type — no extra import needed, it's self-contained)
export interface ValidationResult {
  passed: boolean;
  stage: 'tsc' | 'lint' | 'test';
  error?: string | undefined;
  output?: string | undefined;
}
```

Note the `export` — other files import it from here.

- [ ] **Step 3: Update `engine/implementers/base.ts`**

```ts
// OLD
import type { ImplementerResult } from '../../core/types/summary.js';

// NEW
import type { ImplementerResult } from './types.js';
```

- [ ] **Step 4: Update all `ValidationResult` consumers**

Each file that imported `ValidationResult` from `../../core/types/summary.js` (or deeper relative path) now imports from the validation module. Update each:

`src/engine/orchestrator/validation.test.ts:5`:
```ts
// OLD
import type { ValidationResult } from '../../core/types/summary.js';
// NEW
import type { ValidationResult } from './validation.js';
```

`src/engine/orchestrator/events.ts:6`:
```ts
// OLD
import type { ValidationResult } from '../../core/types/summary.js';
// NEW
import type { ValidationResult } from './validation.js';
```

`src/engine/orchestrator/task/commit.ts:4`:
```ts
// OLD
import type { ValidationResult } from '../../../core/types/summary.js';
// NEW
import type { ValidationResult } from '../validation.js';
```

`src/engine/orchestrator/task/retry.ts:4`:
```ts
// OLD
import type { ValidationResult } from '../../../core/types/summary.js';
// NEW
import type { ValidationResult } from '../validation.js';
```

`src/engine/orchestrator/recovery/builders/task.ts:4`:
```ts
// OLD
import type { ValidationResult } from '../../../../core/types/summary.js';
// NEW
import type { ValidationResult } from '../../validation.js';
```

`src/engine/orchestrator/recovery/builders/shared.ts:4`:
```ts
// OLD
import type { ValidationResult } from '../../../../core/types/summary.js';
// NEW
import type { ValidationResult } from '../../validation.js';
```

`src/engine/orchestrator/evidence/persistence.ts:17`:
```ts
// OLD
import type { ValidationResult } from '../../../core/types/summary.js';
// NEW
import type { ValidationResult } from '../validation.js';
```

`src/engine/orchestrator/evidence/evidence.ts:5`:
```ts
// OLD
import type { ValidationResult } from '../../../core/types/summary.js';
// NEW
import type { ValidationResult } from '../validation.js';
```

`src/engine/orchestrator/evidence/evidence.test.ts:19`:
```ts
// OLD
import type { ValidationResult } from '../../../core/types/summary.js';
// NEW
import type { ValidationResult } from '../validation.js';
```

`testing/helpers/orchestrator-factories.ts:2`:
```ts
// OLD
import type { ValidationResult } from '../../src/core/types/summary.js';
// NEW
import type { ValidationResult } from '../../src/engine/orchestrator/validation.js';
```

- [ ] **Step 5: Delete the old file**

```bash
rm src/core/types/summary.ts
```

- [ ] **Step 6: Search for missed consumers**

```bash
rg "core/types/summary" src/ testing/
```

Expected: zero matches.

- [ ] **Step 7: Verify**

```bash
npm run typecheck
```

Expected: PASS.

---

## Task 6: Decompose `core/readiness/checks.ts` into a folder

**Why:** 572 LOC with 7 distinct `build*Checks` functions. Per STRUCTURE.md, files >300 LOC with >1 responsibility should become a folder with helpers.

**Files:**
- Rename: `src/core/readiness/checks.ts` → `src/core/readiness/checks/build.ts` (entry)
- Create: `src/core/readiness/checks/config.ts` (buildConfigChecks)
- Create: `src/core/readiness/checks/mode.ts` (buildModeChecks)
- Create: `src/core/readiness/checks/runners.ts` (buildRunnerChecks + buildProfileMetadataChecks)
- Create: `src/core/readiness/checks/context.ts` (buildContextChecks)
- Create: `src/core/readiness/checks/validation.ts` (buildValidationChecks)
- Create: `src/core/readiness/checks/repo.ts` (buildRepoChecks)
- Create: `src/core/readiness/checks/cost.ts` (buildCostChecks)
- Move: `src/core/readiness/checks.test.ts` → `src/core/readiness/checks/build.test.ts`
- Modify: All consumers of `./checks.js` (update import paths)

The original file has these functions with their line ranges:
- `buildReadinessReport` (L55-84) — public entry, calls `buildSections`
- `buildSections` (L86-133) — private, composes all section builders
- `buildConfigChecks` (L135-181) — config section
- `buildModeChecks` (L183-208) — mode section
- `buildRunnerChecks` (L210-255) + `runnerCheck` (L292-305) — runner section
- `buildImplementerProfileMetadataChecks` (L257-290) — profiles section
- `buildContextChecks` (L307-353) + `contextLengthCheck` (L324-353) — context section
- `buildValidationChecks` (L355-412) + `testCommandWarning` (L517-547) + `hasKnownLinterConfig` (L549-564) — validation section
- `buildRepoChecks` (L414-464) — repo section
- `buildCostChecks` (L466-510) — cost section
- Shared tiny helpers: `formatRunner` (L512-515), `onOff` (L566-568), `capitalize` (L570-572)

**Target folder structure:**
```
src/core/readiness/checks/
├── build.ts           # entry: buildReadinessReport + buildSections + input types + shared helpers
├── config.ts          # buildConfigChecks
├── mode.ts            # buildModeChecks
├── runners.ts         # buildRunnerChecks + runnerCheck + buildImplementerProfileMetadataChecks
├── context.ts         # buildContextChecks + contextLengthCheck
├── validation.ts      # buildValidationChecks + testCommandWarning + hasKnownLinterConfig
├── repo.ts            # buildRepoChecks
└── cost.ts            # buildCostChecks
```

- [ ] **Step 1: Create the folder and move the original file as a reference**

```bash
mkdir -p src/core/readiness/checks
```

- [ ] **Step 2: Create `checks/config.ts`**

Extract `buildConfigChecks` (lines 135-181) into this file. It needs:
```ts
import type { ReadinessCheck } from '../types.js';
```
Plus the `ConfigReadinessInput` interface (lines 17-23 of original). Export both:
```ts
export interface ConfigReadinessInput { ... }
export function buildConfigChecks(configLoad: ConfigReadinessInput): ReadinessCheck[] { ... }
```

- [ ] **Step 3: Create `checks/mode.ts`**

Extract `buildModeChecks` (lines 183-208). It needs:
```ts
import { resolveMode, resolveApproveLevel } from '../../config/runtime/resolve.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
```
Export: `export function buildModeChecks(config: Config): ReadinessCheck[] { ... }`

- [ ] **Step 4: Create `checks/runners.ts`**

Extract `buildRunnerChecks` (lines 210-255), `runnerCheck` (lines 292-305), and `buildImplementerProfileMetadataChecks` (lines 257-290). It needs:
```ts
import { getRunnerDisplayName, getRunnerModelName } from '../../config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { isProviderLocal, isProviderSubscription } from '../../providers/catalog.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
```
Export both `buildRunnerChecks` and `buildImplementerProfileMetadataChecks`.

Include the `formatRunner` helper (L512-515) since it's only used by runner checks.

- [ ] **Step 5: Create `checks/context.ts`**

Extract `buildContextChecks` (lines 307-353) + `contextLengthCheck` (lines 324-353). It needs:
```ts
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
```
Export: `export function buildContextChecks(config: Config): ReadinessCheck[] { ... }`

Also move `MODE_CONTEXT_FLOORS` (L48-53) here since it's only used by context checks.

- [ ] **Step 6: Create `checks/validation.ts`**

Extract `buildValidationChecks` (lines 355-412) + `testCommandWarning` (L517-547) + `hasKnownLinterConfig` (L549-564). It needs:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
```
Plus the `PackageScriptsReadinessInput` interface.
Export both the interface and the function.

- [ ] **Step 7: Create `checks/repo.ts`**

Extract `buildRepoChecks` (lines 414-464). It needs:
```ts
import type { ReadinessCheck } from '../types.js';
```
Plus the `RepoReadinessInput` interface.
Export both.

- [ ] **Step 8: Create `checks/cost.ts`**

Extract `buildCostChecks` (lines 466-510). It needs:
```ts
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
```
Export: `export function buildCostChecks(config: Config): ReadinessCheck[] { ... }`

- [ ] **Step 9: Create `checks/build.ts` (entry file)**

This file contains:
- `BuildReadinessReportInput` interface (exported)
- `buildReadinessReport` function (exported, L55-84)
- `buildSections` function (private, L86-133)
- `onOff` and `capitalize` helpers (if used by build.ts, otherwise move to the sub-file that uses them)

```ts
import { flattenReadinessChecks, countReadinessChecks, aggregateReadinessStatus, selectNextAction } from '../status.js';
import { resolveMode, resolveApproveLevel, resolveEffortLevel } from '../../config/runtime/resolve.js';
import { buildConfigChecks } from './config.js';
import { buildModeChecks } from './mode.js';
import { buildRunnerChecks, buildImplementerProfileMetadataChecks } from './runners.js';
import { buildContextChecks } from './context.js';
import { buildValidationChecks } from './validation.js';
import { buildRepoChecks } from './repo.js';
import { buildCostChecks } from './cost.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck, ReadinessReport, ReadinessSection } from '../types.js';
import type { ConfigReadinessInput } from './config.js';
import type { PackageScriptsReadinessInput } from './validation.js';
import type { RepoReadinessInput } from './repo.js';

export type { ConfigReadinessInput, PackageScriptsReadinessInput, RepoReadinessInput };

export interface BuildReadinessReportInput {
  projectDir: string;
  config?: Config | undefined;
  configLoad: ConfigReadinessInput;
  packageScripts: PackageScriptsReadinessInput;
  repo: RepoReadinessInput;
}

export function buildReadinessReport(input: BuildReadinessReportInput): ReadinessReport {
  // ... keep existing implementation from lines 55-84
}

function buildSections(input: BuildReadinessReportInput): ReadinessSection[] {
  // ... keep existing implementation from lines 86-133
  // calls all the build*Checks functions imported above
}
```

- [ ] **Step 10: Delete the original file**

```bash
rm src/core/readiness/checks.ts
```

- [ ] **Step 11: Update consumers**

```bash
rg "from.*readiness/checks" src/
```

Consumers import from `./checks.js` — update to `./checks/build.js`:

In `src/core/readiness/collect.ts`:
```ts
// OLD
import { buildReadinessReport } from './checks.js';
import type { BuildReadinessReportInput, ConfigReadinessInput, PackageScriptsReadinessInput, RepoReadinessInput } from './checks.js';

// NEW
import { buildReadinessReport } from './checks/build.js';
import type { BuildReadinessReportInput, ConfigReadinessInput, PackageScriptsReadinessInput, RepoReadinessInput } from './checks/build.js';
```

Repeat for any other consumers found by the grep.

- [ ] **Step 12: Move the test file**

```bash
mv src/core/readiness/checks.test.ts src/core/readiness/checks/build.test.ts
```

Update relative imports inside the test file (e.g., `./checks.js` → `./build.js`).

- [ ] **Step 13: Verify**

```bash
npx vitest run src/core/readiness/
npm run typecheck
```

Expected: all PASS.

---

## Task 7: Inject timestamp parameter into `createInitialState`

**Why:** `new Date()` inside `createInitialState` and `markRecoveryApplying` makes pure state transitions impure. The pattern used in `generateSessionId` (accepting `now: Date = new Date()`) is the correct approach.

**Files:**
- Modify: `src/core/state/machine.ts:86,94,127`
- Modify: All callers of `createInitialState` (add the `now` argument or accept default)
- Modify: `src/core/state/machine.test.ts` (if it calls `createInitialState`)

- [ ] **Step 1: Update `createInitialState` signature**

In `src/core/state/machine.ts`, change line 86:

```ts
// OLD
export function createInitialState(feature: string): WorkflowState {
  return {
    stateVersion: CURRENT_STATE_VERSION,
    phase: 'idle',
    feature,
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: { ...zeroTokenUsage },
    awaitingContinue: false,
    messageQueue: [],
  };
}

// NEW
export function createInitialState(feature: string, now: Date = new Date()): WorkflowState {
  return {
    stateVersion: CURRENT_STATE_VERSION,
    phase: 'idle',
    feature,
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: now.toISOString(),
    tokenUsage: { ...zeroTokenUsage },
    awaitingContinue: false,
    messageQueue: [],
  };
}
```

- [ ] **Step 2: Update `markRecoveryApplying`**

In `src/core/state/machine.ts`, at line 119:

```ts
// OLD
function markRecoveryApplying(state: WorkflowState, action: Extract<StateAction, { type: 'MARK_RECOVERY_APPLYING' }>): WorkflowState {
  if (!state.pendingRecovery) return state;
  return {
    ...state,
    pendingRecovery: {
      ...state.pendingRecovery,
      status: 'applying',
      selectedAction: action.action,
      selectedAt: action.selectedAt ?? new Date().toISOString(),
    },
  };
}

// NEW
function markRecoveryApplying(state: WorkflowState, action: Extract<StateAction, { type: 'MARK_RECOVERY_APPLYING' }>, now: Date = new Date()): WorkflowState {
  if (!state.pendingRecovery) return state;
  return {
    ...state,
    pendingRecovery: {
      ...state.pendingRecovery,
      status: 'applying',
      selectedAction: action.action,
      selectedAt: action.selectedAt ?? now.toISOString(),
    },
  };
}
```

- [ ] **Step 3: Find the `DRAIN_QUEUE` case with `new Date()`**

Read the `transition` function and find the `DRAIN_QUEUE` case. Apply the same pattern — accept `now` from the action payload or default.

- [ ] **Step 4: Search for callers of `createInitialState`**

```bash
rg "createInitialState\(" src/ --glob '!*.test.ts'
```

Existing callers can keep using the default parameter — no changes needed unless they already construct a Date for other reasons.

- [ ] **Step 5: Verify**

```bash
npx vitest run src/core/state/machine.test.ts
npm run typecheck
```

Expected: PASS.

---

## Task 8: Replace `throw new Error` with typed error factory

**Why:** `src/core/config/accessors/implementer-profiles.ts:72` is the only `throw new Error(...)` in core/. Every other domain error uses the `xxxError = { kind, matches }` factory pattern.

**Files:**
- Modify: `src/core/config/accessors/implementer-profiles.ts:72`
- Modify: `src/core/config/errors.ts` (add error kind if not already there)

- [ ] **Step 1: Check if a suitable error kind already exists in config/errors.ts**

Read `src/core/config/errors.ts` for existing error kinds. Look for something like `invalidProfile` or `missingProfile`.

- [ ] **Step 2: Add error factory if needed**

In `src/core/config/errors.ts`, add:

```ts
profileNotFound: (defaultName: string) =>
  error(
    'config-profile-not-found',
    `Default implementer profile "${defaultName}" is not defined.`,
    { defaultName },
  ),
isProfileNotFound: matches('config-profile-not-found'),
```

- [ ] **Step 3: Update the throw site**

In `src/core/config/accessors/implementer-profiles.ts:70-72`:

```ts
// OLD
  const defaultProfile = profiles.find(profile => profile.isDefault);
  if (!defaultProfile) {
    throw new Error(`Default implementer profile "${defaultName}" is not defined`);
  }

// NEW
  const defaultProfile = profiles.find(profile => profile.isDefault);
  if (!defaultProfile) {
    throw configError.profileNotFound(defaultName);
  }
```

Add the import at the top:

```ts
import { configError } from '../errors.js';
```

- [ ] **Step 4: Verify**

```bash
npx vitest run src/core/config/
npm run typecheck
```

Expected: PASS.

---

## Task 9: Remove re-export from `schemas/approval-store.ts`

**Why:** Line 3 is a pure re-export (`export { ActionClassSchema } from './enums.js'`), which is banned per NO-BARRELS.md. Consumers should import `ActionClassSchema` directly from `enums.js`.

**Files:**
- Modify: `src/core/schemas/approval-store.ts:3`
- Modify: Any consumers that import `ActionClassSchema` from `approval-store.js`

- [ ] **Step 1: Find consumers of the re-export**

```bash
rg "from.*approval-store" src/ --glob '!*.test.ts'
```

Check which imports use `ActionClassSchema` from `approval-store.js` vs from `enums.js`.

- [ ] **Step 2: Remove the re-export line**

In `src/core/schemas/approval-store.ts`, remove line 3:

```ts
// REMOVE
export { ActionClassSchema } from './enums.js';
```

Keep the private import on line 2 (needed for the schema definition):

```ts
import { ActionClassSchema } from './enums.js';
```

- [ ] **Step 3: Update any consumers to import from `enums.js` directly**

For any file that was importing `ActionClassSchema` from `approval-store.js`, change to:

```ts
import { ActionClassSchema } from './enums.js';
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck
```

Expected: PASS.

---

## Task 10: Delete `schemas/approval-store.test.ts`

**Why:** All 4 tests are pure Zod shape assertions (parse empty array, throw on missing version, throw on invalid class, throw on invalid scope). Per TESTING.md rule 11: "Zod schemas do NOT get shape tests — TS strict + Zod parse is first-class correctness."

**Files:**
- Delete: `src/core/schemas/approval-store.test.ts`

- [ ] **Step 1: Delete the file**

```bash
rm src/core/schemas/approval-store.test.ts
```

- [ ] **Step 2: Verify tests still pass**

```bash
npm test
```

Expected: PASS (one fewer test file).

---

## Task 11: Delete `schemas/codebase.test.ts`

**Why:** 3 tests — "parses with all defaults" (passthrough on Zod defaults), "rejects negative tokenBudget" (Zod `.min()` shape), "rejects tokenBudget over ceiling" (Zod `.max()` shape). All are shape tests per TESTING.md rule 11.

**Files:**
- Delete: `src/core/schemas/codebase.test.ts`

- [ ] **Step 1: Delete the file**

```bash
rm src/core/schemas/codebase.test.ts
```

- [ ] **Step 2: Verify**

```bash
npm test
```

Expected: PASS.

---

## Task 12: Delete `schemas/otel.test.ts`

**Why:** Single test: `parse({}); expect(result.enabled).toBe(false); expect(result.serviceName).toBe('diptych')`. Pure passthrough on 2 Zod defaults. TESTING.md rule 11.

**Files:**
- Delete: `src/core/schemas/otel.test.ts`

- [ ] **Step 1: Delete the file**

```bash
rm src/core/schemas/otel.test.ts
```

- [ ] **Step 2: Verify**

```bash
npm test
```

Expected: PASS.

---

## Task 13: Delete `schemas/evidence.test.ts`

**Why:** 6 tests — all are Zod literal accept/reject for `briefHash` optional/nullable field. The schema plus TS strict already proves this. Per TESTING.md rule 11.

**Files:**
- Delete: `src/core/schemas/evidence.test.ts`

- [ ] **Step 1: Delete the file**

```bash
rm src/core/schemas/evidence.test.ts
```

- [ ] **Step 2: Verify**

```bash
npm test
```

Expected: PASS.

---

## Task 14: Prune passthrough tests from `schemas/config.test.ts`

**Why:** 13+ tests are pure passthrough (parse a literal → assert the same values back). Per TESTING.md rules 7 (don't re-assert a literal) and 11 (no Zod shape tests). Keep the 7 refinement tests that encode product policy.

**Files:**
- Modify: `src/core/schemas/config.test.ts`

- [ ] **Step 1: Read the full test file**

Identify tests to DELETE (passthrough / shape):
- "parses config without palette field"
- "parses config with palette.customActions"
- "parses minimal config without approval field"
- "parses approval: { enabled: true } with defaults"
- "preserves approval.enabled: false"
- "preserves approval.headless: true"
- "preserves approval.feedRejectionsToPlanner: false"
- "parses old single implementer config without profiles"
- "allows profiles without an explicit default"
- "keeps plannerEstimateReview off in the default config"
- "preserves plannerEstimateReview opt-in"
- "keeps autoSplitOverflow off in the default config"
- "preserves autoSplitOverflow opt-in"

Identify tests to KEEP (product policy refinements):
- "throws when id is empty string"
- "throws when command does not start with /"
- "throws on invalid tier string"
- "parses named implementer profiles with metadata"
- "rejects unknown default profile names"
- "rejects invalid profile names"
- "rejects empty profile maps"

- [ ] **Step 2: Remove the passthrough tests**

Delete each identified passthrough test. If a `describe` block becomes empty after removal, delete the entire `describe` block.

- [ ] **Step 3: Verify**

```bash
npx vitest run src/core/schemas/config.test.ts
```

Expected: all remaining tests PASS.

---

## Task 15: Prune shape tests from `schemas/hooks.test.ts`

**Why:** 6 shape tests that just verify Zod parsing of valid/invalid literals. Keep the 6 refinement tests.

**Files:**
- Modify: `src/core/schemas/hooks.test.ts`

- [ ] **Step 1: Read the test file and identify tests to delete**

DELETE:
- "parses a valid entry with defaults"
- "parses command entry without kind field"
- "parses command entry with explicit kind"
- "rejects missing command"
- "rejects missing path for module entry"
- "parses a config with multiple events and entries"

KEEP:
- "parses module entry with kind: module"
- "rejects module entry with command field (strict)"
- "rejects command entry with path field (strict)"
- "rejects command 'sh'"
- "rejects command '/bin/bash'"
- "rejects timeout over 300_000"

- [ ] **Step 2: Remove the shape tests**

- [ ] **Step 3: Verify**

```bash
npx vitest run src/core/schemas/hooks.test.ts
```

Expected: PASS.

---

## Task 16: Prune literal echo test from `schemas/enums.test.ts`

**Why:** The "RECOVERY_ACTIONS includes all v1 recovery actions" test re-asserts the exported array literal. Per TESTING.md rule 7: don't re-assert a literal you just set up.

**Files:**
- Modify: `src/core/schemas/enums.test.ts`

- [ ] **Step 1: Read the file and identify the test**

Look for a test that asserts `RECOVERY_ACTIONS` contains specific string values that are the same as the production constant.

- [ ] **Step 2: Remove only that test**

Keep: `normalizeLegacyMode` tests, "WORKFLOW_MODES does not include full", "WorkflowModeSchema rejects full".

- [ ] **Step 3: Verify**

```bash
npx vitest run src/core/schemas/enums.test.ts
```

Expected: PASS.

---

## Task 17: Prune passthrough test from `schemas/workflow.test.ts`

**Why:** The "parses new state with pendingRecovery" test sets up a full object and asserts the same values back. Per TESTING.md rule 7.

**Files:**
- Modify: `src/core/schemas/workflow.test.ts`

- [ ] **Step 1: Read the file and identify the passthrough test**

The first test ("parses old state without pendingRecovery") is a legitimate backward-compat guard — KEEP.
The second test ("parses new state with pendingRecovery") is passthrough — DELETE or reduce to `expect(result.success).toBe(true)`.

- [ ] **Step 2: Simplify the test**

If the test provides backward-compat value (proving the new field is accepted), reduce it to:

```ts
it('accepts state with pendingRecovery field', () => {
  const result = WorkflowStateSchema.safeParse({ ...validState, pendingRecovery: { /* minimal */ } });
  expect(result.success).toBe(true);
});
```

- [ ] **Step 3: Verify**

```bash
npx vitest run src/core/schemas/workflow.test.ts
```

Expected: PASS.

---

## Task 18: Extract shared `clamp` to `core/layout/`

**Why:** `clamp(value, min, max)` is duplicated in `conversation-scroll.ts:31` and `scroll-window.ts:24`. DRY at 2nd occurrence — since both are in the same folder, extract to a shared sibling.

**Files:**
- Create: `src/core/layout/math.ts`
- Modify: `src/core/layout/conversation-scroll.ts:30-32` (remove local, add import)
- Modify: `src/core/layout/scroll-window.ts:24-26` (remove local, add import)

- [ ] **Step 1: Create the shared file**

Write `src/core/layout/math.ts`:

```ts
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
```

- [ ] **Step 2: Update `conversation-scroll.ts`**

Remove lines 30-32 (local `clamp`), add import:

```ts
import { clamp } from './math.js';
```

- [ ] **Step 3: Update `scroll-window.ts`**

Remove lines 24-26 (local `clamp`), add import:

```ts
import { clamp } from './math.js';
```

- [ ] **Step 4: Verify**

```bash
npx vitest run src/core/layout/
npm run typecheck
```

Expected: all PASS.

---

## Task 19: Fix `overrides.ts` unnecessary exhaustive switch + `as` cast

**Why:** `applyPlannerEffort` has a 5-case switch that does the same thing in every case. Also, line 119 has an unsanctioned `as ApproveLevel` cast.

**Files:**
- Modify: `src/core/config/runtime/overrides.ts:119,165-176`

- [ ] **Step 1: Fix the `as ApproveLevel` cast on line 119**

```ts
// OLD
...(overrides.autoApprove ? { approve: 'none' as ApproveLevel } : {}),

// NEW — use satisfies to prove the literal is valid
...(overrides.autoApprove ? { approve: 'none' satisfies ApproveLevel } : {}),
```

If `satisfies` does not work in this spread context (TypeScript may widen), alternatively:

```ts
// ALT — extract to a typed const
const autoApproveOverride: { approve: ApproveLevel } = { approve: 'none' };
...(overrides.autoApprove ? autoApproveOverride : {}),
```

- [ ] **Step 2: Simplify `applyPlannerEffort`**

```ts
// OLD
function applyPlannerEffort(config: Config, effort: EffortLevel): Config {
  const planner: PlannerConfig = (() => {
    switch (config.planner.kind) {
      case 'cli': return { ...config.planner, effort };
      case 'api': return { ...config.planner, effort };
      case 'shell': return { ...config.planner, effort };
      case 'agent': return { ...config.planner, effort };
      case 'agent-sdk': return { ...config.planner, effort };
    }
  })();
  return { ...config, planner };
}

// NEW
function applyPlannerEffort(config: Config, effort: EffortLevel): Config {
  return { ...config, planner: { ...config.planner, effort } };
}
```

- [ ] **Step 3: Verify**

```bash
npx vitest run src/core/config/runtime/overrides.test.ts
npm run typecheck
```

Expected: PASS.

---

## Task 20: Full revalidation

**Why:** After all tasks complete, run the full test suite and re-audit for any remaining violations.

- [ ] **Step 1: Run the full test-ci pipeline**

```bash
npm run test-ci
```

Expected: typecheck PASS, lint PASS, all tests PASS.

- [ ] **Step 2: Verify zero barrels**

```bash
find src -name 'index.ts' -type f
```

Expected: zero results.

- [ ] **Step 3: Verify zero `simple-git` imports outside `lib/git.ts`**

```bash
rg "from 'simple-git'" src/ --glob '!src/lib/git.ts' --glob '!*.test.ts'
```

Expected: zero results.

- [ ] **Step 4: Verify zero `class` keyword**

```bash
rg '\bclass\b' src/ --type ts --glob '!*.test.ts' --glob '!*.d.ts'
```

Expected: zero matches (or only string literals in non-production files).

- [ ] **Step 5: Verify import directions**

```bash
rg "from '.*engine/" src/core/ --glob '!*.test.ts'
rg "from '.*stores/" src/core/ --glob '!*.test.ts'
rg "from '.*features/" src/core/ --glob '!*.test.ts'
rg "from '.*components/" src/core/ --glob '!*.test.ts'
rg "from '.*hooks/" src/core/ --glob '!*.test.ts'
```

Expected: zero matches for all.

- [ ] **Step 6: Verify zero `core/types/workflow-events` and `core/types/summary` references**

```bash
rg "core/types/workflow-events" src/ testing/
rg "core/types/summary" src/ testing/
```

Expected: zero matches.

- [ ] **Step 7: Verify `core/features/` directory is gone**

```bash
ls src/core/features/ 2>&1
```

Expected: "No such file or directory".

- [ ] **Step 8: Count remaining `as ` casts in core/ production files**

```bash
rg '\bas\b ' src/core/ --type ts --glob '!*.test.ts' -c
```

Document any remaining unsanctioned casts for the next iteration.

- [ ] **Step 9: Run biome lint**

```bash
npm run lint
```

Expected: PASS.

---

- [ ] **Step 10: Produce delta report**

If any verification step above fails, document:
1. **New violations introduced** by Tasks 1-19 (side effects)
2. **Remaining deferred items** from the list below that should be promoted

If delta is non-empty, file a new plan (`2026-05-01-core-sota-refactor-iter2.md`) covering only the delta items. Repeat until `npm run test-ci` is green AND all verification greps return zero matches.

---

## Iteration protocol

This plan covers iteration 1. After Task 20 revalidation:
- If **test-ci passes** and **all greps are clean**: SOTA 5/5 for iteration 1 scope. Assess deferred items for iteration 2.
- If **test-ci fails** or **greps find violations**: fix in the same session, re-run Task 20.
- If **deferred items** are promoted to "must fix": create `2026-05-01-core-sota-refactor-iter2.md` with those tasks.

---

## Post-plan notes

### What was NOT included (deferred to next iteration):

1. **`core/readiness/collect.ts:138`** — unsanctioned `as { scripts?: unknown }` cast. Requires refactoring the package.json parsing to use proper type narrowing. Small but fiddly.
2. **`core/schemas/enums.ts:112`** — `input as LegacyWorkflowMode` cast. Guarded by `in` check but not in exception list. Needs investigation of TS narrowing limitations.
3. **`core/hooks/trust.ts:33`** — `JSON.parse(...) as TrustFile`. Could add a Zod schema, but the file is simple enough that the risk is low.
4. **`core/sessions/io.ts:36-48`** — raw fs APIs instead of `lib/fs.ts` wrappers. Functional but inconsistent.
5. **`core/state/persistence.ts:63-84`** — `appendEngineEvent` duplicates `appendLine` I/O pattern.
6. **`core/schemas/review-packet.ts`** — inline re-definitions of evidence schemas and CostBreakdown.
7. **`core/schemas/analyze.ts:6`** — `orphanTasks` uses `z.string()` instead of `TaskIdSchema`.
8. **Low-value test consolidation** — `runner-config.test.ts`, `estimate.test.ts`, `chrome-rows.test.ts` could be collapsed with `it.each` but work as-is.
9. **Missing `.strict()` on persisted schemas** — needs careful analysis of forward-compat implications.
10. **`core/types/state-actions.ts`** — bundles 4 unrelated concepts but is borderline (fan-in 12, 2 folders).

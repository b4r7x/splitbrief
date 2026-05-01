# SOTA 02: Fix Layer Inversion (events imports orchestrator)

> **For agentic workers:** Execute task-by-task. After ALL tasks: run `npm run test-ci`.

**Goal:** Move `workflow-events.ts` from `orchestrator/` to `events/` so the event layer doesn't depend on the orchestrator layer.

**NEVER run `git commit` or `git add`** — leave all changes unstaged.

---

### Task 1: Move the file

- [ ] **Step 1: Move `workflow-events.ts`**

```bash
mv src/engine/orchestrator/workflow-events.ts src/engine/events/workflow-events.ts
```

- [ ] **Step 2: Update import in `src/engine/events/types.ts`**

Find lines 7-9:

```typescript
import type { UserEditConflict, UserEditConflictAction } from '../orchestrator/workflow-events.js';
import type { CurrentCodeContextMode, TaskContextFit } from '../orchestrator/workflow-events.js';
import type { TaskReviewRequest } from '../orchestrator/workflow-events.js';
```

Replace with:

```typescript
import type { UserEditConflict, UserEditConflictAction } from './workflow-events.js';
import type { CurrentCodeContextMode, TaskContextFit } from './workflow-events.js';
import type { TaskReviewRequest } from './workflow-events.js';
```

---

### Task 2: Fix all broken imports

- [ ] **Step 1: Find all files importing from the old path**

Run:
```bash
grep -r "workflow-events" src/ --include="*.ts" --include="*.tsx" -l
```

- [ ] **Step 2: For each file found, fix the import path**

The file moved FROM `src/engine/orchestrator/workflow-events.ts` TO `src/engine/events/workflow-events.ts`.

Rules for updating each importing file:
- If file is in `src/engine/orchestrator/` → change `./workflow-events.js` to `../events/workflow-events.js`
- If file is in `src/engine/orchestrator/task/` → change `../workflow-events.js` to `../../events/workflow-events.js`
- If file is in `src/engine/orchestrator/recovery/` → change `../workflow-events.js` to `../../events/workflow-events.js`
- If file is in `src/engine/orchestrator/evidence/` → change `../workflow-events.js` to `../../events/workflow-events.js`
- If file is in `src/engine/orchestrator/evidence/review-packet/` → change `../../workflow-events.js` to `../../../events/workflow-events.js`
- If file is in `src/engine/orchestrator/user-edit/` → change `../workflow-events.js` to `../../events/workflow-events.js`
- If file is in `src/engine/orchestrator/planning/` → change `../workflow-events.js` to `../../events/workflow-events.js`
- If file is in `src/stores/` → update accordingly (follow the relative path to `src/engine/events/workflow-events.js`)

- [ ] **Step 3: Verify zero broken imports**

Run: `npm run typecheck`
Expected: PASS with zero errors

---

### Task 3: Full verification

- [ ] **Step 1: Run the complete check**

Run: `npm run test-ci`
Expected: PASS

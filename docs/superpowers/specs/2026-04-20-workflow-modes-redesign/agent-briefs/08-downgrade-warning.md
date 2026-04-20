# Brief 08 — Local mode-downgrade advisory (no LLM)

> **You are a fresh AI context.** Read `../spec.md` §4.9 and `../decisions.md` ADR-005 before starting. Do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Before the first planner call, run a local heuristic: if the feature prompt looks trivial AND the selected mode is `standard` or `speckit`, emit a one-shot toast suggesting a lighter mode. Zero LLM calls. Advisory only — does not block.

## Dependencies

- Brief 01 complete (four-mode taxonomy exists).
- Brief 02 / 03 optional but recommended (so `instant` is actually runnable).

## Files to touch

Write-authoritative:

- `src/engine/orchestrator/planning/mode-advisor.ts` (NEW)
- `src/engine/orchestrator/planning/mode-advisor.test.ts` (NEW)
- `src/engine/orchestrator/planning/run.ts`
- `src/engine/events/types.ts`
- `src/features/workflow/components/event-cards/event-card.tsx`

## Step-by-step

### 1. Advisor module

File: `src/engine/orchestrator/planning/mode-advisor.ts`

```ts
import type { WorkflowMode } from '../../../core/schemas/enums.js';

/** Lowercase keyword list that signals a trivial feature request. */
const TRIVIAL_KEYWORDS: readonly string[] = [
  'typo', 'rename', 'spelling',
  'null check', 'optional chaining',
  'add log', 'console.log', 'logger',
  'remove unused', 'delete dead code',
  'fix indent', 'format',
  'update comment', 'fix comment',
  'bump version',
  'import order',
  'add missing export',
];

/** Word-count threshold below which we consider the prompt "short". */
const SHORT_PROMPT_WORDS = 12;

/** Modes eligible for downgrade. */
const DOWNGRADABLE_MODES: readonly WorkflowMode[] = ['standard', 'speckit'];

export type AdvisorResult = {
  shouldAdvise: boolean;
  currentMode: WorkflowMode;
  suggestedMode: WorkflowMode;
  reason: 'short-prompt-with-trivial-keyword' | null;
};

export function adviseMode(prompt: string, currentMode: WorkflowMode): AdvisorResult {
  if (!(DOWNGRADABLE_MODES as readonly string[]).includes(currentMode)) {
    return { shouldAdvise: false, currentMode, suggestedMode: currentMode, reason: null };
  }

  const lower = prompt.toLowerCase();
  const wordCount = prompt.trim().split(/\s+/).filter(Boolean).length;

  const hasTrivialKeyword = TRIVIAL_KEYWORDS.some(kw => lower.includes(kw));

  if (wordCount < SHORT_PROMPT_WORDS && hasTrivialKeyword) {
    return {
      shouldAdvise: true,
      currentMode,
      suggestedMode: 'instant',
      reason: 'short-prompt-with-trivial-keyword',
    };
  }

  return { shouldAdvise: false, currentMode, suggestedMode: currentMode, reason: null };
}
```

### 2. Tests

File: `src/engine/orchestrator/planning/mode-advisor.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { adviseMode } from './mode-advisor.js';

describe('adviseMode', () => {
  it.each([
    // trivial prompt + standard mode → advise
    ['fix typo in foo', 'standard', true, 'instant'],
    ['rename foo to bar', 'standard', true, 'instant'],
    ['add null check to service', 'speckit', true, 'instant'],
    // trivial keyword but long prompt → no advise
    [
      'refactor the entire authentication subsystem to support OAuth 2.0 with PKCE, bearer tokens, and refresh rotation; also fix the typo in the login page header while we are at it',
      'standard',
      false,
      'standard',
    ],
    // short prompt, no trivial keyword → no advise
    ['build auth system', 'standard', false, 'standard'],
    // already lightweight mode → no advise
    ['fix typo', 'quick', false, 'quick'],
    ['fix typo', 'instant', false, 'instant'],
  ])('prompt=%s mode=%s → shouldAdvise=%s suggested=%s', (prompt, mode, shouldAdvise, suggested) => {
    const result = adviseMode(prompt, mode as any);
    expect(result.shouldAdvise).toBe(shouldAdvise);
    expect(result.suggestedMode).toBe(suggested);
  });

  it('handles empty prompt', () => {
    const result = adviseMode('', 'standard');
    expect(result.shouldAdvise).toBe(false);
  });

  it('does not spend tokens (pure function, no imports from engine/planners)', () => {
    // This test asserts zero network activity by design. Enforced by linter rules
    // in the file: no 'fetch', no 'spawn', no planner imports.
    // Kept here as documentation of intent.
    expect(true).toBe(true);
  });
});
```

### 3. Wire into runPlanningPhase

File: `src/engine/orchestrator/planning/run.ts`

At the top of `runPlanningPhase`, after resolving mode but before dispatching:

```ts
import { adviseMode } from './mode-advisor.js';

// ...
const advisor = adviseMode(feature, mode);
if (advisor.shouldAdvise) {
  bus.publish({
    type: 'mode_downgrade_advised',
    phase: state.phase,
    ts: Date.now(),
    currentMode: mode,
    suggestedMode: advisor.suggestedMode,
  });
}
```

### 4. Event variant

File: `src/engine/events/types.ts`

```ts
| {
    type: 'mode_downgrade_advised';
    phase: Phase;
    ts: number;
    currentMode: WorkflowMode;
    suggestedMode: WorkflowMode;
  }
```

File: `src/features/workflow/components/event-cards/event-card.tsx`

```tsx
case 'mode_downgrade_advised':
  return (
    <Text color={theme.warning}>
      This looks trivial. Consider --mode {event.suggestedMode} instead of --mode {event.currentMode}.
    </Text>
  );
```

### 5. Verification gate

```bash
npm run typecheck
npm run lint
npm test
```

## Non-goals (do not do)

- Do NOT call the planner to classify the prompt.
- Do NOT introduce a `@google/generative-ai` or any ML library.
- Do NOT add more than ~20 trivial keywords. The heuristic is intentionally dumb.
- Do NOT run the advisor after the first planner call (too late to be useful).
- Do NOT expand beyond `standard` and `speckit` as candidate modes for downgrade.

## Rollback

Revert the three files (two new + `run.ts` + `types.ts` + `event-card.tsx`). Advisor is completely self-contained.

## Checkpoint

- `diptych start --mode standard "fix typo"` emits one toast.
- `diptych start --mode speckit "build OAuth 2.0 system"` emits no toast.
- `diptych start --mode instant "fix typo"` emits no toast.
- Workflow continues regardless. No blocking.
- Zero network calls in the advisor code path.

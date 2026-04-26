# 04 — TUI Approval Prompt

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Agent: TUI Approval Prompt implementer
Brief: 04 of 06 (Tiered Approval Gates spec)

## Intent

Create an Ink/React TUI component that renders an interactive approval prompt. The component is tier-aware: sticky tier shows 3–4 options; confirm tier shows a text-input flow requiring the phrase `I confirm`. The component reads from and writes to an `approval-prompt` store, following the same store-first pattern as the rest of the workflow screen.

## Scope

**In bounds:**
- `src/stores/approval-prompt/store.ts` (new file) — `useApprovalPromptStore`, state shape
- `src/stores/approval-prompt/actions.ts` (new file) — pure action functions
- `src/features/workflow/components/approval-prompt.tsx` (new file) — Ink component
- `src/features/workflow/hooks/use-workflow-runner.ts` — wire up `onTieredApproval` callback inside the `callbacks` object (small addition only; this is where all other callbacks like `onApprovalNeeded` are assembled)

**Out of bounds:**
- Do not modify `src/engine/orchestrator/tiered-approval.ts` (brief 02 owns that).
- Do not add useMemo, useCallback, React.memo, or forwardRef anywhere.
- Do not create an `index.ts` in any new directory.
- Do not touch other store files.

## Code Context

Read before implementing:

- `src/engine/orchestrator/types.ts` — `TieredApprovalRequest`, `TieredApprovalResponse` (from brief 02), `OrchestratorCallbacks`
- `src/engine/orchestrator/tiered-approval.ts` — request/response types
- `src/stores/create-store.ts` — how other stores are created in this project
- `src/stores/use-stores.ts` — how stores are accessed in components
- `src/features/workflow/hooks/use-workflow-runner.ts` — the actual file where `OrchestratorCallbacks` is assembled (callbacks object around line 102); how `onApprovalNeeded` is wired; follow the same `inputMode.setReviewMode` pattern for the new callback
- `docs/STORES.md` — store conventions: zero memoization, pure actions
- `docs/HOOKS.md` — hook conventions

## Implementation Plan

### 1. Define store state in `src/stores/approval-prompt/store.ts`

```ts
export type ApprovalPromptState =
  | { status: 'idle' }
  | {
      status: 'pending';
      request: TieredApprovalRequest;
      resolve: (response: TieredApprovalResponse) => void;
    };
```

Use the same `createStore` pattern as other stores in this project. Export `useApprovalPromptStore`.

### 2. Define actions in `src/stores/approval-prompt/actions.ts`

```ts
export function openApprovalPrompt(
  request: TieredApprovalRequest,
): Promise<TieredApprovalResponse>
// Opens the prompt, returns a promise that resolves when the user responds.
// Stores resolve function in state.status === 'pending'.

export function closeApprovalPrompt(): void
// Resets state to idle.
```

### 3. Implement `ApprovalPrompt` component in `src/features/workflow/components/approval-prompt.tsx`

The component renders when `state.status === 'pending'`. It reads `state.request.tier` and renders the appropriate layout:

**Sticky tier layout:**
```
[?] Write outside task scope: <actionDescription>
  [A] Approve once
  [S] Approve for this session
  [W] Always approve (saved to .diptych/approvals.json)
  [X] Deny
```
Keyboard handlers:
- `a` / `A` → `{ decision: 'allow', scope: 'once' }`
- `s` / `S` → `{ decision: 'allow', scope: 'session' }`
- `w` / `W` → `{ decision: 'allow', scope: 'always' }`
- `x` / `X` or `Escape` → `{ decision: 'deny', reason: 'user_cancelled' }`

**Confirm tier layout (two sub-steps):**

Step 1 — show action and instructions:
```
[!] Destructive action: <actionDescription>
    Type "I confirm" to proceed, or press Escape to cancel.
    Phrase: [_________]
```

Step 2 — after correct phrase, show reason prompt:
```
    Phrase accepted. Enter reason: [_________]
    (Press Enter to confirm, Escape to cancel)
```

If phrase is wrong, shake the input (clear and show inline error).

On complete confirm: `{ decision: 'confirm', phrase: 'I confirm', reason: <value> }`.

Use `useInput` from Ink for key handling. Use `useState` for local text field state only (phrase and reason inputs). No `useCallback` or `useMemo`.

### 4. Wire up in `src/features/workflow/hooks/use-workflow-runner.ts`

Inside the `callbacks` object (around line 102, alongside `onApprovalNeeded`), add:

```ts
onTieredApproval: (request) => openApprovalPrompt(request),
```

Render `<ApprovalPrompt />` in `src/features/workflow/screen.tsx` alongside other overlay components. It renders nothing when `state.status === 'idle'`.

## Validation

### Tests

The store and actions are unit-testable:
- `openApprovalPrompt` returns a pending promise; calling the stored `resolve` settles it.
- `closeApprovalPrompt` resets state to idle without rejecting any pending promise.
- Calling `openApprovalPrompt` while another is pending: replace the old pending state (call previous resolve with deny + reason `'superseded'`).

The component is integration-testable via Ink's `render` + `stdin` injection if the Ink test environment is available. If not, document that manual TUI testing is required and provide a smoke test that mounts the component without error.

## Constraints

- Zero `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle`.
- No `useRef` unless required for Ink's `useInput` focus management (Ink itself requires it internally — that is acceptable; do not add extra refs).
- No `index.ts` in `src/stores/approval-prompt/`.
- The component must not import anything from `src/engine/` directly — receive request data via the store only.
- The `resolve` function stored in state is a plain function reference; do not wrap it.
- Local `useState` for the text input value is acceptable; it is view state, not domain state.

## Escalation

If Ink's `useInput` text mode (for free-text entry of the phrase and reason) is unavailable or unstable in the target Ink version (6.x), fall back to a message-queue approach: the confirm tier renders instructions and the user types their phrase into the existing workflow input bar. Route the input to the pending approval prompt if one is active. Describe this fallback in a code comment.

## Evidence Requirements

- New file: `src/stores/approval-prompt/store.ts`
- New file: `src/stores/approval-prompt/actions.ts`
- New file: `src/features/workflow/components/approval-prompt.tsx`
- Modified: `src/features/workflow/screen.tsx`
- Store tests pass
- Typecheck clean: `npm run typecheck`

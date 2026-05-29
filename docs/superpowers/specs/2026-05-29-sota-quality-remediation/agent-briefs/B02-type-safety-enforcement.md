# B02 — Type-safety enforcement & exhaustiveness

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Turn the codebase's "no unsafe assertions" + "exhaustive switches" conventions from
prose into enforced gates, then fix every site the gates surface. Concretely: enable
`tsconfig` `noImplicitReturns`; add an unsafe-assertion grep gate to
`scripts/check-invariants.ts` (the authoritative mechanism per **D1**, not Biome
overrides); close every closed-union `switch`/if-chain with `assertNever`; remove the
4 incidental `!` and the handful of broad `as` casts the audit named; brand stray
`taskId` fields; and delete two semantic-free type aliases. After this brief, a new
union member or a stray `!`/cast fails CI instead of silently compiling.

## Wave / ordering

- **Wave:** 1. **Runs after:** B01 (formatting sweep, SOLO) because `biome format
  --write` reflows nearly every file; B02's edits must land in already-formatted files.
  Runs concurrently-serialized with B03 (schema single-sourcing) — writes are
  serialized one-brief-at-a-time, so read the current tree and build on whatever landed
  first.
- **Decisions that bind this brief:**
  - **D1** — Unsafe-assertion enforcement is an **invariants grep gate** in
    `scripts/check-invariants.ts`, **not** per-file Biome `overrides`. Keep Biome's
    `noNonNullAssertion`/`noExplicitAny` as-is (`"off"`). The grep gate is the
    authoritative enforcer, allow-listing exactly the sanctioned sites named in
    `CLAUDE.md`.

## File ownership

**Edit (config / gate):**
- `tsconfig.json` — add `"noImplicitReturns": true`.
- `scripts/check-invariants.ts` — add the unsafe-assertion gate (D1). **Collision:**
  shared with B14 (`B02 → B14`); B14 later adds a knip/ts-prune gate. You own ONLY the
  unsafe-assertion gate entry; do not touch other gates.
- `biome.json` — no rule changes (D1 keeps `noNonNullAssertion`/`noExplicitAny` off).
  Touch only if a formatting/whitespace fix is needed after B01; otherwise leave as-is.

**Edit (exhaustiveness — add `default: return assertNever(x)`):**
- `src/engine/orchestrator/context-routing/context-length.ts` (TS-06)
- `src/stores/navigation/router.ts` (TS-10) — **Collision** `B02 → B13`: you own the
  `navigate` switch exhaustiveness only; B13 later shares `RouteData`/`NavigateArgs`.
- `src/engine/runners/factory.ts` (TS-14, two switches) — **Collision** `B02 → B05 →
  B07`: you own ONLY the two `kind` switches' `default` arms. B05 adds a structured
  agent-sdk error (EH-09); B07 changes `createAgentSdkPlanner`/`createClaudeCodePlanner`
  signatures. Do not touch `agentSdkMissingError`/`ensureAgentSdkPackage` or the planner
  factory signatures.
- `src/engine/providers/openai-stream.ts` (TS-14)
- `src/features/workflow/recovery-prompt.ts` (TS-14)
- `src/features/workflow/user-edit-conflict-prompt.ts` (TS-14)
- `src/cli/commands/migrate.ts` (TS-14)
- `src/features/workflow/components/conversation-flow/conversation-row-view.tsx` (TS-14)
- `src/app/keys.ts` (TS-14)
- `src/features/workflow/hooks/use-plan-editor-keys.ts` (TS-14)
- `src/features/workflow/hooks/use-ipc-prompt-dispatcher.ts` (TS-14, if-chain → assertNever)
- `src/core/config/runtime/overrides.ts` (TS-14, `existingToOpts` if-chain → assertNever)

**Edit (unsafe casts / `!` removal):**
- `src/stores/project/config.ts` (TS-05) — **Collision** `B02 → B08 → B11`: you own ONLY
  the 3 `as` casts at lines 98/102/108. B08 adds param objects to
  `persistedValue`/`persistedConfig`; B11 extracts `config-persistence.ts`. Do not split
  the file or reshape function signatures.
- `src/utils/canonical-json.ts` (TS-16)
- `src/utils/fuzzy-match.ts` (TS-16)
- `src/cli/commands/approval.ts` (TS-15)
- `src/cli/commands/handoff.ts` (TS-15)
- `src/engine/ipc/prompt-tracker.ts` (TS-18)
- `src/engine/events/sinks/tree-recorder.ts` (TS-22, the 2 `!` at lines 39 & 54)
- `src/engine/codebase/repomap.ts` (TS-22, the `!` at line 88)
- `src/features/workflow/components/plan-editor/external-editor.ts` (TS-22, the `!` at line 92)

**Edit (TaskId branding — TS-07):**
- `src/core/schemas/review-packet.ts` (lines 188, 218)
- `src/core/schemas/drift.ts` (line 19) — **soft collision with B03** (B03 owns DRY-42
  `DriftReportSchema.safeParse`). You own ONLY the `taskId` field type. Build on B03's
  edit if it landed first; do not revert it.
- `src/core/schemas/drift-chain.ts` (lines 4, 19)
- `src/core/schemas/summary.ts` (line 96) — **soft collision with B03** (B03 owns enum
  single-sourcing here). You own ONLY the `taskId` field type.

**Edit (alias / widening cleanup):**
- `src/core/types/config-options.ts` (TS-13, line 13: drop `PlannerTool` alias)
- `src/stores/workflow/plan-editor.ts` (TS-13 line 8: drop `PlanReviewCostTier` alias;
  TS-17 line 16: `kind: string` → `UserEditConflictKind`)
- `src/engine/worktree.ts` (TS-20, lines 79 & 200: fold `deleteBranch?` into
  `RemoveWorktreeOptions`)
- `src/engine/handoff/write.ts` (TS-21, line 23: `HandoffTarget | string` → `string`)
- `src/core/settings/catalog.ts` (TS-19) — see step 13 for the chosen resolution.

**Call-site edits (consumers of the changed types):** `src/engine/detection/detect.ts`,
`src/engine/skill-discovery.ts`, `src/core/config/accessors/runner-config.ts` (PlannerTool
consumers); `src/features/workflow/components/brief-review.ts` (PlanReviewCostTier
consumer). Enumerated in step 11.

**Create:** none.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| TS-01 (= DELTA-02) | high | `tsconfig.json:2-24` | Add `"noImplicitReturns": true`; fix the value-returning switches it surfaces (see step 2). |
| TS-02 (= DELTA-03) | high | `biome.json:32,44`; gate in `scripts/check-invariants.ts` | Add unsafe-assertion grep gate (D1); fix the 4 incidental `!` (TS-22) and the broad casts (TS-05/15/16/18). Keep Biome rules off. |
| TS-05 | med | `stores/project/config.ts:98,102,108` | Replace `as Config` / `as Record<string,unknown>` with a typed recursive projector + `ConfigSchema` re-validation (step 7). |
| TS-06 | med | `engine/orchestrator/context-routing/context-length.ts:10-17` | `profileProviderId`: `default: return assertNever(config)`. |
| TS-07 | med | `core/schemas/review-packet.ts:188,218`; `drift.ts:19`; `drift-chain.ts:4,19`; `summary.ts:96` | Use `TaskIdSchema` for every `taskId`/`detectedAtTaskId` field. |
| TS-10 | med | `stores/navigation/router.ts:43-70` | `navigate`: `default: return assertNever(args)`. |
| TS-13 | low | `core/types/config-options.ts:13`; `stores/workflow/plan-editor.ts:8` | Drop `PlannerTool` and `PlanReviewCostTier` aliases; use `PlannerToolId` / `ImplementerCostTier`. |
| TS-14 | l–h | 11 closed-union switches/if-chains (listed in step 2) | Add `default: return assertNever(x)`; enable `noImplicitReturns` for value-returning ones. |
| TS-15 | low | `cli/commands/approval.ts:76,83` + `handoff.ts:60,66` | Replace `VALID_X.includes(raw as T)` + `raw as T` with the existing `includes<T>` guard from `utils/type-guards.ts`. |
| TS-16 | low | `utils/canonical-json.ts:23-28` + `utils/fuzzy-match.ts:15` | Use `isRecord` to narrow; drop the `as Record` casts and the redundant `as Set<number>`. |
| TS-17 | low | `stores/workflow/plan-editor.ts:16` | `PlanReviewConflictMetadata.kind: string` → `UserEditConflictKind`. |
| TS-18 | low | `engine/ipc/prompt-tracker.ts:61-65` | Replace `... as IpcPromptRequest` with a typed construction that preserves union narrowing (step 9). |
| TS-19 | low | `core/settings/catalog.ts:11` | Add a test asserting every `SettingDef.id` resolves via the config accessors (step 13). |
| TS-20 | low | `engine/worktree.ts:79,200` | Move `deleteBranch?: boolean` into `RemoveWorktreeOptions`; drop the inline intersection at line 200. |
| TS-21 | low | `engine/handoff/write.ts:23` | `target: HandoffTarget \| string` → `target: string` (the union collapses anyway). |
| TS-22 (= TS-02) | low | `repomap.ts:88`, `external-editor.ts:92`, `tree-recorder.ts:39,54` | Remove the 4 incidental `!`; guard/restructure (step 6). |
| DELTA-02 | high | `tsconfig` lacks `noImplicitReturns` | = TS-01. |
| DELTA-03 | high | `noNonNullAssertion`/`noExplicitAny` off, no gate | = TS-02 (D1). |

## Required changes

Read each file's current source before editing — line numbers below were verified
against the live tree but may shift by a line or two after B01's reflow. Use the
`assertNever` already exported from `src/utils/type-guards.ts`
(`import { assertNever } from '<rel>/utils/type-guards.js'`).

### 1. Enable `noImplicitReturns`

In `tsconfig.json`, add `"noImplicitReturns": true` inside `compilerOptions` (e.g. next
to `"noFallthroughCasesInSwitch": true`). Then run `npm run typecheck` and fix **every**
error it surfaces. `noImplicitReturns` is a global rule — the value-returning switches in
the TS-14 table (step 2) are the **expected** set, not a cap; if typecheck flags a
function outside that list (an early-return missing a value, a non-switch branch), fix it
too with the minimal correct return or guard. Where a switch's missing return is the
exhaustiveness hole, the correct fix is the `assertNever` default (step 2), which both
satisfies `noImplicitReturns` and enforces exhaustiveness — do **not** add a hand-written
fallback return where `assertNever` is the right answer.

### 2. Close every closed-union switch / if-chain with `assertNever`

For each value-returning switch, add a final `default: return assertNever(<discriminated
value>);` arm. For `void` switches, add `default: return assertNever(<value>);` (the
`return` is fine in a `void` function). Pass the **whole discriminated object** when the
switch is on a `.kind`/`.type`/`.role` property (so it narrows to `never`), or the value
itself when switching on a bare union.

| File | Current | Add |
|---|---|---|
| `engine/orchestrator/context-routing/context-length.ts:10-17` | `default: return 'unknown';` | replace that line with `default: return assertNever(config);` |
| `stores/navigation/router.ts:43-70` | switch on `args.to`, no default | `default: return assertNever(args);` |
| `engine/runners/factory.ts:70` (`loadPlanner`) | `default: throw runnerConfigError.invalidKind(String(kind), 'planner');` | replace with `default: return assertNever(kind);` |
| `engine/runners/factory.ts:107` (`createImplementer`) | `default: throw runnerConfigError.invalidKind(String(kind), 'implementer');` | replace with `default: return assertNever(kind);` |
| `engine/providers/openai-stream.ts:72` (`toOpenAIMessage`) | switch on `message.role`, no default | `default: return assertNever(message);` |
| `features/workflow/recovery-prompt.ts:49` (`formatRecoveryActionText`) | switch on `action`, no default | `default: return assertNever(action);` |
| `features/workflow/user-edit-conflict-prompt.ts:12` (`toRecoveryAction`) | switch on `action`, no default | `default: return assertNever(action);` |
| `cli/commands/migrate.ts:13` (`printMigrationResult`) | switch on `result.status`, no default | `default: return assertNever(result);` |
| `features/workflow/components/conversation-flow/conversation-row-view.tsx:6` (`colorForTone`) | switch on `tone`, no default | `default: return assertNever(tone);` |
| `app/keys.ts:29` (`applyAction`) | switch on `action.type`, no default | `default: return assertNever(action);` |
| `features/workflow/hooks/use-plan-editor-keys.ts:67` (`applyPlanEditorAction`) | switch on `action.type`, no default | `default: return assertNever(action);` |

Note `colorForTone` switches on `ConversationRowTone | undefined` with `case undefined:`
already handled; after all cases `tone` narrows to `never`, so `assertNever(tone)` is
valid.

**Two if-chains** (audit lists these under TS-14; they are exhaustive discriminated-union
dispatches whose final arm silently swallows an unhandled kind):

- `features/workflow/hooks/use-ipc-prompt-dispatcher.ts:11-74` — the chain of
  `if (request.kind === '…')` ends with a bare fall-through returning
  `{ kind: 'tiered_approval', … }`. Restructure the **last** arm into an explicit
  `if (request.kind === 'tiered_approval') { … return …; }` and follow it with
  `return assertNever(request);`. This makes a newly-added prompt kind a compile error at
  this process boundary (the audit's stated worst case).
- `core/config/runtime/overrides.ts:37-48` (`existingToOpts`) — the if-chain ends with a
  bare `return { kind: 'agent-sdk', … }`. Change that to
  `if (existing.kind === 'agent-sdk') { return { kind: 'agent-sdk', … }; }` followed by
  `return assertNever(existing);`.

`core/state/machine.ts:376` and `engine/orchestrator/recovery/actions.ts:120` already use
`assertNever` — mark TS-14 PASS for those if you encounter them; do not change. (The
collision-map row for `core/runtime/commands/registry.ts` mentions "switch exhaustiveness"
for B02, but `registry.ts` has **no** switch statement — treat that line as a no-op for
B02 and leave the file untouched; B11 owns its other concerns.)

### 3. Add the unsafe-assertion invariants gate (D1)

In `scripts/check-invariants.ts`, append **one** new `Gate` entry to the `gates` array
(keep the existing `id` numbering style — use a fresh id such as `'17'`). The gate must
catch incidental non-null assertions and `any`, allow-listing the sanctioned sites from
`CLAUDE.md`. Use the same `{ id, description, command, expected }` shape and bash/ripgrep
mechanics as the existing gates (commands run under `/bin/bash -o pipefail`; output must
be a single integer; trailing `|| true` so a zero-match `rg` exits 0).

Add these three gate entries (or combine into one with summed counts — three separate
entries is clearer and matches the file's style):

1. **No incidental `!` non-null assertions** — `expected: 0`. Grep `src/` for the
   non-null-assertion form (a `!` immediately after an identifier/`)`/`]` that is not
   `!=`/`!==`), excluding test files and the sanctioned files named in CLAUDE.md
   (`src/utils/type-guards.ts`, `src/stores/create-store.ts`, `src/stores/use-stores.ts`,
   `src/engine/codebase/graph.ts`, `src/engine/codebase/pagerank.ts`,
   `src/lib/terminal/mouse.ts`). Verified live: after step 6 fixes the 4 sites, the only
   remaining `!` are in `graph.ts`, `pagerank.ts`, and `use-stores.ts` — all sanctioned.
   Suggested command (PCRE):
   ```
   { rg -n -P "[A-Za-z0-9_)\]]![^=)]" src/ -g '*.ts' -g '*.tsx' -g '!**/*.test.ts' -g '!**/*.test.tsx' | rg -v "!==|!=" | rg -v "^src/(utils/type-guards|stores/create-store|stores/use-stores|engine/codebase/graph|engine/codebase/pagerank|lib/terminal/mouse)\.ts:" || true; } | wc -l
   ```
   Verify the count is `0` after your step-6 fixes before committing the gate.

2. **No explicit `any`** — `expected: 0`. Grep `src/` (excluding tests) for real `any`
   type positions (`: any`, `<any>`, `any[]`, `as any`, `Array<any>`). Verified live:
   production source has **zero** real `any` (the only `\bany\b` match is the word "any"
   in a prompt string in `engine/spec/prompts/analyze.ts`, which the precise pattern
   excludes). Suggested command:
   ```
   { rg -n -P ":\s*any\b|<any>|\bany\[\]|\bas any\b|Array<any>" src/ -g '*.ts' -g '*.tsx' -g '!**/*.test.ts' -g '!**/*.test.tsx' || true; } | wc -l
   ```

3. **No incidental broad `as` casts** — `expected: 0`. Grep for the cast forms
   (`<expr> as <CapitalizedType>`), excluding `as const`, `as unknown`, test files, and
   the sanctioned/legitimate sites. Verified live, after your steps 7/8/9 remove the
   casts in `config.ts`, `canonical-json.ts`, `fuzzy-match.ts`, `approval.ts`,
   `handoff.ts`, `prompt-tracker.ts`, the residual `as <Type>` casts are exactly:
   `src/stores/use-stores.ts` (sanctioned), `src/engine/hooks/substitute.ts` +
   `src/engine/hooks/dispatch.ts` (sanctioned), `src/utils/error.ts` (the foundational
   `AppError` builder — allow-list it), `src/engine/ipc/server-entry.ts` +
   `src/features/workflow/components/latest-event-selector.ts` (legitimate
   `as Extract<…>` discriminated-union narrowing after a runtime check),
   `src/core/project-meta.ts` (owned by B12/DRY-40 — allow-list until then),
   `src/core/schemas/drift.ts` (the `as Record<string,unknown>` cast there is owned by
   B03/DRY-42 — allow-list **the whole file**, not a line anchor: your step 10 adds an
   import to drift.ts which shifts that cast's line, and B01's reflow shifts lines too —
   never line-anchor an allow-list in a sweep), and `src/engine/ipc/prompt-tracker.ts`
   (the single localized `as IpcPromptRequest` you keep per step 9 / TS-18). Suggested
   command:
   ```
   { rg -n -P "[)\]A-Za-z0-9_>] as [A-Z]" src/ -g '*.ts' -g '*.tsx' -g '!**/*.test.ts' -g '!**/*.test.tsx' | rg -v "\bas const\b|\bas unknown\b| as Extract<" | rg -v "^src/(stores/use-stores|engine/hooks/substitute|engine/hooks/dispatch|utils/error|core/project-meta|core/schemas/drift|engine/ipc/prompt-tracker)\.ts:" || true; } | wc -l
   ```
   The ` as Extract<` exclusion covers `server-entry.ts` and `latest-event-selector.ts`
   (both legitimate). **Before adding this gate, run the command and confirm it prints
   `0`.** If it prints non-zero, the extra lines are casts you must either fix (if they
   belong to a TS-0x finding above) or add to the allow-list (only if sanctioned in
   CLAUDE.md or owned by another brief). Do **not** loosen the pattern to make it pass —
   tighten the allow-list to the exact file path.

After adding the gate(s), run `npm run check:invariants` and confirm all gates pass.

### 4. (router.ts) — done by step 2

`navigate` is `void`; `default: return assertNever(args)` is valid. No other change.

### 5. (factory.ts) — done by step 2

Both switches are on the **local** `const kind = config.planner.kind` (and
`config.implementer.kind`), which is the closed `RunnerKind` union (`z.infer<typeof
RunnerKindSchema>`), so after the 5 cases `kind` narrows to `never` and
`assertNever(kind)` typechecks under every TS version (the current `String(kind)` in the
default already proves `kind` is `never` there). Use `assertNever(kind)`, not
`assertNever(config.planner)` — the local discriminant is the robust form. `assertNever`
throws at runtime, preserving the previous "invalid kind throws" behavior;
`runnerConfigError.invalidKind` becomes
unused in this file — leave the import only if still referenced elsewhere, otherwise
remove the now-dead named import to satisfy `noUnusedLocals`. Do **not** delete
`runnerConfigError` from `errors.ts`.

### 6. Remove the 4 incidental `!` (TS-22)

- `engine/events/sinks/tree-recorder.ts:39` and `:54` — both are
  `const root = tree.entries.get(tree.meta.leafId)!;`. Replace each with a guarded read:
  ```ts
  const root = tree.entries.get(tree.meta.leafId);
  if (!root) return; // or the function's existing no-op/early-return shape
  ```
  Read the surrounding function to choose the correct early-return value (these are sink
  recorders; returning early on a missing root is the safe no-op). Note `tree-recorder.ts`
  is also referenced by B05 (EH-14, catch justification at lines 31/43/58) — you own only
  the `!` removals; do not touch the catch blocks.
- `engine/codebase/repomap.ts:88` — `const file = files[idx]!;`. Read the loop; `idx`
  indexes into `files`. Restructure to a guarded read (`const file = files[idx]; if
  (!file) continue;`) consistent with the loop's control flow. (B10 owns repomap's SRP
  split and EH-17; you own only this `!`.)
- `features/workflow/components/plan-editor/external-editor.ts:92` —
  `updated[cursor] = { ...parsed[0]!, status: 'pending' as const };`. The code already
  guards `parsed.length !== 1` (returns early) and `cursor < 0` (returns early) just
  above, so `parsed[0]` is present. Replace with a guarded local:
  ```ts
  const first = parsed[0];
  if (!first) return;
  updated[cursor] = { ...first, status: 'pending' as const };
  ```
  (`as const` is sanctioned — keep it.)

### 7. (config.ts TS-05) Remove the 3 `as` casts

Current (lines 98/102/108):
```ts
return persistedValueForSave(persisted, effective, updated, [], changedPaths) as Config; // 98
let current: Record<string, unknown> = target as Record<string, unknown>;                // 102
current = current[key] as Record<string, unknown>;                                       // 108
```
Resolution (D1 / audit fix: "re-validate through `ConfigSchema`, or type the projector
against the recursive structure"):

- Line 98: `persistedValueForSave` returns `unknown`. Re-validate through the schema:
  import `ConfigSchema` from `../../core/schemas/config.js` and return
  `ConfigSchema.parse(persistedValueForSave(persisted, effective, updated, [], changedPaths))`.
  This drops the `as Config` and guarantees a valid `Config` is persisted. (Confirm
  `ConfigSchema` is the exported parser; if the export name differs, use the canonical
  config schema already used by `loadConfig`/`writeConfig`.)
- `setPath` (lines 101-112): retype it to walk a `Record<string, unknown>` without
  casting `Config`. Change the signature to
  `function setPath(target: Record<string, unknown>, path: Path, value: unknown): void`
  and update its single caller in `persistedConfigForSave` (line 93) to pass the cloned
  config through a single boundary cast localized at the call (or, cleaner, type `next`
  as `Record<string, unknown>` there). The inner `current[key] as Record<string,
  unknown>` (line 108) is then replaced by a guarded narrow:
  ```ts
  const child = current[key];
  current = isRecord(child) ? child : (current[key] = {});
  ```
  `isRecord` is already imported in this file. The goal: zero `as Config` /
  `as Record<string,unknown>` casts remain in `config.ts`. Do not change the persistence
  semantics (the cloning/`changedPaths` logic) — only the typing.

### 8. (TS-16) canonical-json & fuzzy-match

- `utils/canonical-json.ts:22-28`: the block already checks `typeof value === 'object'`.
  Import `isRecord` from `./type-guards.js` and narrow once at the top of that branch:
  ```ts
  if (isRecord(value)) {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`);
    return `{${pairs.join(',')}}`;
  }
  ```
  Note `isRecord` returns false for arrays, but the `Array.isArray` branch already runs
  earlier, so behavior is preserved. Remove all three `as Record<string, unknown>` casts.
- `utils/fuzzy-match.ts:15`: drop the `as Set<number>` cast. `top.positions` from fzf is
  already a `Set<number>` (the audit confirms fzf types it). Use
  `Array.from(top.positions)`. If `top.positions` is typed as a readonly/iterable that
  `Array.from` accepts without the cast, this compiles cleanly; verify with `typecheck`.

### 9. (TS-15 & TS-18) shared `includes` guard; prompt-tracker

- TS-15: `cli/commands/approval.ts:76,83` and `cli/commands/handoff.ts:60,66` both do
  `VALID_X.includes(raw as T)` then `const x = raw as T`. The codebase already exports a
  sound guard: `includes<T>(arr: readonly T[], item: unknown): item is T` in
  `src/utils/type-guards.ts`. Use it:
  ```ts
  // approval.ts
  if (!includes(VALID_SCOPES, rawScope)) { throw cliError(`Unknown --scope: "${rawScope}". Valid scopes: ${VALID_SCOPES.join(', ')}`, 1); }
  const scope = rawScope; // now narrowed to ClearScope
  ```
  Same shape for `handoff.ts` with `VALID_MODES`/`WriteMode`/`rawMode`. Add
  `import { includes } from '<rel>/utils/type-guards.js';` to each file (path:
  `../../utils/type-guards.js` from `cli/commands/`). This removes all four `as` casts.
  (The audit phrases the fix as "shared `isClearScope` guard"; the existing generic
  `includes` guard is the canonical single source and avoids inventing a one-off helper —
  prefer it.)
- TS-18: `engine/ipc/prompt-tracker.ts:61-65`, `requestClientPrompt`, currently:
  ```ts
  const request = { ...requestWithoutId, requestId: `prompt-${nextPromptId++}` } as IpcPromptRequest;
  ```
  A spread over a discriminated union (`IpcPromptRequestInput`) plus `as IpcPromptRequest`
  cannot be made fully cast-free without reshaping `IpcPromptRequest`/`IpcPromptRequestInput`
  in `protocol.ts` — and `protocol.ts` is **B03's** (EH-16/DRY-33); do not touch it.
  **Chosen resolution (single, deterministic):** keep one localized
  `as IpcPromptRequest` (a sanctioned spread-narrowing limitation across a closed union),
  and **pre-include `engine/ipc/prompt-tracker.ts` in the step-3 `as`-gate allow-list now**
  (it is already added to the suggested command's exclusion list — see step 3). Do not
  attempt a `satisfies`/distributed-`Omit` rewrite here; it does not buy soundness while
  the input union is defined externally. This is the only B02 site that remains an
  allow-listed cast rather than being removed.

### 10. (TS-07) Brand stray `taskId` fields

Change `z.string()` → `TaskIdSchema` (and `z.string().optional()` →
`TaskIdSchema.optional()`) for these fields. Add `import { TaskIdSchema } from
'./task.js';` where the file does not already import it (`drift.ts`, `drift-chain.ts`,
`summary.ts` do not; `review-packet.ts` already imports it at line 13).

- `core/schemas/review-packet.ts:188` — `taskId: z.string().optional()` → `TaskIdSchema.optional()`
- `core/schemas/review-packet.ts:218` — `detectedAtTaskId: z.string()` → `TaskIdSchema`
- `core/schemas/drift.ts:19` — `taskId: z.string().optional()` → `TaskIdSchema.optional()`
- `core/schemas/drift-chain.ts:4` — `taskId: z.string()` → `TaskIdSchema`
- `core/schemas/drift-chain.ts:19` — `detectedAtTaskId: z.string()` → `TaskIdSchema`
- `core/schemas/summary.ts:96` — `taskId: z.string()` → `TaskIdSchema`

**Risk to verify:** branding changes the `z.infer` field type from `string` to `TaskId`.
After editing, run `npm run typecheck` and fix any **producer** that assigns a plain
string into these fields (a read of a branded field as string is fine; writing an
unbranded string into a branded field is the error). Likely producers: the drift/summary
builders in `engine/orchestrator/drift/` and `core/readiness`/summary assembly. Where a
producer has the task id as a plain string, brand it at the boundary with `taskId(s)`
(the constructor exported from `core/schemas/task.ts`) or read it from an already-branded
`Task.id`. Do not weaken the schema back to `z.string()` to dodge the error.

### 11. (TS-13) Drop the two semantic-free aliases + update consumers

- `core/types/config-options.ts:13` — delete `export type PlannerTool = PlannerToolId;`.
  `PlannerToolId` is already imported at line 1. Update in-file uses: line ~45
  `tool: PlannerTool;` (in `PlannerDetection`) → `tool: PlannerToolId;`.
- External `PlannerTool` consumers (replace the import + usages with `PlannerToolId`,
  importing from `core/schemas/enums.js`):
  - `engine/detection/detect.ts` — imports `PlannerTool` from `config-options.js`; used in
    `CLI_PLANNERS`, `API_PLANNERS`, `PROVIDER_PLANNERS`, `minimalConfig`. Switch to
    `PlannerToolId`.
  - `engine/skill-discovery.ts` — `getGlobalDir`, `getProjectDir`, `discoverSkills`
    parameter types.
  - `core/config/accessors/runner-config.ts` — `getPlannerToolId` return type imports
    `PlannerTool`.
  (Run `rg -n "\bPlannerTool\b" src` to confirm you caught them all after editing.)
- `stores/workflow/plan-editor.ts:8` — delete `export type PlanReviewCostTier =
  ImplementerCostTier;`. `ImplementerCostTier` is already imported at line 3. Update
  in-file use at line ~25 `selectedCostTier?: PlanReviewCostTier | undefined;` →
  `ImplementerCostTier`.
- External `PlanReviewCostTier` consumer: `features/workflow/components/brief-review.ts`
  imports `PlanReviewCostTier` from `plan-editor.js` and uses it in `COST_TIER_ORDER` and
  `new Map<PlanReviewCostTier, number>()`. Switch the import to `ImplementerCostTier` from
  `core/schemas/implementer-config.js` (or re-export path the file already uses). Note
  `brief-review.ts` is touched by B09→B11 (SRP split / facade); you own ONLY this type
  rename — do not split the file.

### 12. (TS-17) plan-editor conflict kind

In `stores/workflow/plan-editor.ts`, `PlanReviewConflictMetadata.kind: string` (line 16)
→ `kind: UserEditConflictKind`. `UserEditConflictKind` is exported from
`src/engine/events/workflow-events.ts`. Add
`import type { UserEditConflictKind } from '../../engine/events/workflow-events.js';`.
**Verify the layering:** `stores/` may import from `engine/` (only `engine/` is barred
from importing UI). Confirm with `npm run check:invariants` (gate 12 is the reverse
direction). After the change, run typecheck and fix any site that assigns a non-union
string into `conflict.kind`.

### 13. (TS-19) settings catalog id resolution

`core/settings/catalog.ts:11` — `SettingDef.id: string` is consumed as a config dot-path;
a typo silently no-ops. The audit offers two options: a literal union of config paths, or
a test asserting each id resolves. A literal union is brittle against the recursive
`Config` shape and would churn other briefs. **Chosen resolution (lower blast radius):
add a test.** Verified accessor: `getConfigValue(config, dotPath): unknown` is exported
from `src/core/config/accessors/state.ts`, and the settings UI reads a def via
`def.readValue ? def.readValue(config) : getConfigValue(config, def.id)` (see
`src/features/settings/hooks/editor.ts:37-38`). Create
`src/core/settings/catalog.test.ts` (colocated, per convention). In it: build a `Config`
via `loadConfig(<a temp/fixture dir>)` (returns `{ config, warnings }`, from
`src/core/config/load/load.ts`) or parse the canonical config schema's defaults; then for
each `def` of `SETTINGS_DEFS` **without** a `readValue` override, assert
`getConfigValue(config, def.id)` returns a non-`undefined` value (a typo'd dot-path
returns `undefined`, which is the silent-no-op bug this guards). Import `SETTINGS_DEFS`
from `./catalog.js` and `getConfigValue` from
`../config/accessors/state.js`. This satisfies TS-19 without changing the type; leave
`SettingDef.id: string`.

### 14. (TS-20) worktree deleteBranch

`engine/worktree.ts`: move the inline `& { deleteBranch?: boolean }` (line 200) into the
named type. Edit `RemoveWorktreeOptions` (lines 79-84) to add
`deleteBranch?: boolean | undefined;` (match the file's `exactOptionalPropertyTypes`
style — note the file uses bare `force?: boolean;`, so use `deleteBranch?: boolean;` to be
consistent). Change `removeWorktree`'s signature (line 199-201) from
`opts: RemoveWorktreeOptions & { deleteBranch?: boolean }` to `opts: RemoveWorktreeOptions`.
The destructure at line 202 (`deleteBranch = false`) stays. Check callers of
`removeWorktree` still typecheck (they pass an object literal — no change needed).

### 15. (TS-21) handoff target

`engine/handoff/write.ts:23` — `target: HandoffTarget | string` collapses to `string`.
Change to `target: string;` and remove the now-unused `HandoffTarget` import **iff** it is
not used elsewhere in the file (check first; if used elsewhere keep the import). Update the
adjacent comment (line 22) only if it now misleads — keep it terse, no decorative
additions. Confirm no caller relied on the `HandoffTarget` narrowing for this field.

## Out of scope (owned elsewhere — do NOT touch)

- `engine/events/{types,schema,workflow-events}.ts` EngineEvent `z.infer`, `z.custom`
  drop, conflict-kind/action/context-fit tuples → **B03** (TS-03, TS-04, DRY-01).
- `engine/streaming/output-parsers.ts` usage schema, `engine/ipc/server-args.ts`,
  `engine/ipc/protocol.ts`, `engine/mcp/handlers.ts` → **B03** (TS-08, TS-09, EH-16,
  DRY-33/76). Do not edit `protocol.ts`; only consume its types (step 9).
- `engine/orchestrator/task/routing-fields.ts` `Pick<RoutingDecision>` → **B03** (TS-11).
- `core/schemas/drift.ts` `DriftReportSchema.safeParse` (DRY-42) and `summary.ts` enum
  single-sourcing → **B03**. You touch only the `taskId` field types in those files; do
  not add `safeParse` or share enums.
- `engine/events/sinks/tree-recorder.ts` `totalCost` payload (TS-12) and the catch
  justifications (EH-14) → **B05**. You touch only the two `!` at lines 39/54.
- `engine/runners/factory.ts` structured agent-sdk error (EH-09) → **B07**; planner
  factory signatures (PD-23) → **B07**. You touch only the two switch `default` arms.
- `stores/project/config.ts` param objects → **B08**; `config-persistence.ts` split →
  **B11**. You touch only the 3 casts.
- `core/runtime/commands/registry.ts` (no switch exists for B02) → phase predicates /
  messages / EH-15 → **B11**.
- `stores/navigation/router.ts` `RouteData`/`NavigateArgs` sharing (DRY-23) → **B13**.
- `core/state/machine.ts` already uses `assertNever`; its `transition` opts (B08) and
  `rewindReset`/`resetToIdle` (B12) → not B02.
- `core/project-meta.ts` `isRecord` adoption (DRY-40) → **B12**; `repomap.ts` SRP split /
  EH-17 → **B10**. You touch only repomap's one `!`.
- `core/keybindings/registry.ts` relabel (NM-02) → **B16**.

## Acceptance criteria

- [ ] Every finding ID above (TS-01, TS-02, TS-05, TS-06, TS-07, TS-10, TS-13, TS-14,
  TS-15, TS-16, TS-17, TS-18, TS-19, TS-20, TS-21, TS-22; DELTA-02, DELTA-03) is addressed
  in the code.
- [ ] `tsconfig.json` has `"noImplicitReturns": true`; `npm run typecheck` passes with it
  enabled.
- [ ] `scripts/check-invariants.ts` has the unsafe-assertion gate(s); `npm run
  check:invariants` passes (all gates, `expected: 0` for the new `!`/`any`/`as` gates).
- [ ] Every closed-union switch/if-chain in step 2 has an `assertNever` default; removing
  a union arm now produces a compile error (spot-check by temporarily deleting one case —
  do not commit that).
- [ ] The 4 incidental `!` (tree-recorder ×2, repomap, external-editor) are gone; the only
  remaining `!` in `src/` are in the CLAUDE.md-sanctioned files.
- [ ] No `as Config`/`as Record<string,unknown>` in `config.ts`; no `as Record` in
  `canonical-json.ts`; no `as Set<number>` in `fuzzy-match.ts`; no `raw as ClearScope`/`raw
  as WriteMode` in approval/handoff; prompt-tracker construction preserves narrowing (or
  is allow-listed with justification per step 9).
- [ ] `PlannerTool` and `PlanReviewCostTier` aliases deleted; all consumers compile
  against `PlannerToolId` / `ImplementerCostTier`.
- [ ] `taskId`/`detectedAtTaskId` fields in review-packet/drift/drift-chain/summary use
  `TaskIdSchema`; producers brand at the boundary; typecheck green.
- [ ] `RemoveWorktreeOptions` owns `deleteBranch?`; `WriteHandoffOptions.target` is
  `string`; `PlanReviewConflictMetadata.kind` is `UserEditConflictKind`.
- [ ] `core/settings/catalog.test.ts` asserts each `SettingDef.id` resolves.
- [ ] No new `!`/broad `as`/`any`/barrels/non-`Error` classes/memoization introduced;
  every new/changed import uses the `.js` extension; `engine/` imports no `react`/`ink`/
  `features`/`components`/`hooks`/`cli`; no decorative comments added.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (update assertions only where a behavior/type genuinely changed,
  e.g. branded-id tests).

## Tests

```bash
npm test -- src/stores/navigation/router.test.ts \
  src/engine/runners/factory.test.ts \
  src/stores/project/config.test.ts \
  src/core/settings/catalog.test.ts \
  src/core/schemas \
  src/cli/commands/approval.test.ts \
  src/cli/commands/handoff.test.ts \
  src/engine/worktree.test.ts \
  src/features/workflow
npm run typecheck
npm run lint
npm run check:invariants
```

(If a listed test path does not exist, drop it — colocated tests may be named
differently; `npm test` with no path runs the whole suite as a fallback. The
`check:invariants` run is mandatory because B02 adds a gate.)

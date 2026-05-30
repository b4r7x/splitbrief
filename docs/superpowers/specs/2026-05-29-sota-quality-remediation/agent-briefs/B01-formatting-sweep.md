# B01 — Formatting sweep (SOLO)

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Enable the Biome formatter for the first time, configure it to **match the existing
house style** (2-space indent, single quotes), add the documented-but-missing
`format` / `format:check` npm scripts, wire `format:check` into the `test-ci` gate, and
then run `biome format --write .` once so every source file is formatted. This closes
the whole tab/double-quote style cluster (NM-04, FO double-quote-imports) and the
missing-formatting-gate root cause (DELTA-01). The change is **pure whitespace/quotes —
zero semantic change** — but it is intentionally large: the formatter has never run, so
it reflows ~the entire `src/` and `testing/` tree (~880–1040 files). That blast radius
is exactly why this brief is scheduled SOLO and first.

## Wave / ordering

- **Wave:** 1 (SOLO). **Runs after:** nothing — this is the very first brief. Nothing
  may run concurrent with or before it, because `biome format --write` reflows ~every
  file; all later briefs must land their edits **into already-formatted files** so their
  diffs stay reviewable.
- **Decisions that bind this brief:** none directly. D1/D3 (invariants gate, reader
  policy) are B02/B05 concerns — **do not touch** `scripts/check-invariants.ts` or any
  Biome lint rule here. This brief changes only the **formatter** config + scripts +
  the mechanical reflow.

## File ownership

You own, and may edit:

- `biome.json` — enable the formatter; add `indentStyle`/`indentWidth`/`lineWidth` to the
  top-level `formatter` block; add `!**/.tiny-spec` to `files.includes`. **Do NOT touch**
  the `linter` block, `javascript.formatter` quote/semicolon settings (already correct),
  or `assist`.
- `package.json` — add `format` and `format:check` scripts; add `format:check` into the
  `test-ci` chain. Touch **only** the `scripts` object.
- Every formatted source file under `src/`, `testing/`, `evals/`, `scripts/` — produced
  mechanically by `biome format --write .`. You do not hand-edit these; the formatter
  rewrites them.

You also own, and must edit, the two docs the audit ties to this brief — their
`npm run format` lines become accurate once the script exists, and their `test-ci` chain
descriptions go stale the moment you add `format:check` to the chain (fixed in step 3):

- `CONTRIBUTING.md` — `:38` already documents `npm run format` correctly (verify); `:40`
  describes the `test-ci` chain and must gain `format`.
- `CLAUDE.md` — `:28` already documents `npm run format` correctly (verify); `:30` and
  `:93` describe the `test-ci` chain and must gain `format`.

No collision-map row names B01 (it is SOLO). Every later brief edits files this sweep
formats; they build on the formatted tree and must never revert the formatting.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| DELTA-01 | high | `package.json:18-37` (scripts), `biome.json:21-23`, `CONTRIBUTING.md:40`, `CLAUDE.md:30,93` | Formatter is disabled and `npm run format` is documented (CONTRIBUTING.md:38, CLAUDE.md:28) but absent from `package.json`. Enable the formatter, add `format` (`biome format --write .`) and `format:check` (`biome format .`), wire `format:check` into `test-ci`, and update the three stale `test-ci` chain descriptions to include the format step. |
| NM-04 | m/l | tab/double-quote style (the 7 files below) | Enable formatter + `biome format --write .`. Converts the 7 tab-indented files to 2-space and double-quote string literals to single quotes. Files: `src/core/config/accessors/runner-credentials.ts:35`, `src/engine/orchestrator/run/phases.ts:279`, `src/engine/planners/claude-code.ts:18`, `src/engine/orchestrator/evidence/task-evidence.ts:24`, `src/features/runners/tool-row.tsx` (double-quote literals), `src/core/settings/presentation.ts` (double-quote literals + imports). |
| FO double-quote-imports | low | `src/core/settings/presentation.ts:1`, `src/features/runners/tool-row.tsx` (+ `src/engine/providers/openai-stream.test.ts`) | Same `biome format --write .` run converts double-quote `import … from "…"` specifiers to single quotes (`quoteStyle: single` already set in `javascript.formatter`). |

(Cross-check against the Coverage summary: B01 owns exactly **NM-04, DELTA-01, FO
double-quote imports** — three findings, all addressed above.)

## Required changes

Do them strictly in this order. Steps 1–2 (config + scripts) MUST precede step 3 (the
sweep), otherwise the formatter inverts the codebase to tabs (see the warning in step 1).

### 1. Configure the formatter in `biome.json`

Current relevant state:

```jsonc
"files": {
  "includes": [
    "**",
    "!**/dist",
    "!**/node_modules",
    "!**/coverage",
    "!**/.claude",
    "!**/.specify",
    "!**/specs",
    "!**/.diptych",
    "!**/.opencode"
  ]
},
"formatter": {
  "enabled": false
},
```

**(a)** Flip `formatter.enabled` to `true` AND add indent + line-width settings to the
**top-level** `formatter` block (these keys are language-agnostic and are what control
indentation; the existing `javascript.formatter` block only controls quotes/semicolons):

```jsonc
"formatter": {
  "enabled": true,
  "indentStyle": "space",
  "indentWidth": 2,
  "lineWidth": 100
},
```

> **CRITICAL — why `indentStyle: "space"`/`indentWidth: 2` are mandatory, not optional.**
> Biome's *default* `indentStyle` is **tab**. The codebase is written in **2-space**
> (1041 of 1048 `src/` files are 2-space; only 7 stray files use tabs — those 7 are the
> NM-04 violations). If you enable the formatter without setting `indentStyle: "space"`,
> Biome will convert **all 1041 correct files to tabs** — the exact opposite of the house
> style and of NM-04's intent. Setting `space`/`2` makes the formatter *enforce* the
> existing convention: the 7 tab files become 2-space, the rest keep their indentation.

> **`lineWidth: 100` — RATIFY-ME (open decision, not yet pinned by any D#).** There is
> no `.editorconfig` in the repo, so nothing external sources this value. Use **100** as
> the deterministic default for this sweep: Biome's default is 80, but the codebase was
> written loosely around ~100 (line-length p95≈89, p99≈118; ~9.5k lines exceed 80 but
> only ~1.1k exceed 120), so 80 would gratuitously wrap thousands of otherwise-fine
> lines. **Implement with 100 — do not invent a different value.** But flag this to the
> coordinator: `lineWidth` rebases every downstream brief (B02–B16 land edits into files
> this sweep wraps at 100). If a human later prefers 80 or 120, this sweep **and** all 15
> downstream diffs must re-churn. Surface it for ratification before B02 starts; per the
> "nothing silently decided" principle (D13), this width is a visible choice, not a
> blank B01 fills on its own authority.

**(b)** Add `!**/.tiny-spec` to `files.includes` (place it next to `!**/.diptych`). The
project's runtime data dir was renamed `.diptych` → `.tiny-spec`, but the ignore list
was never updated, so the formatter would otherwise rewrite **tracked generated runtime
data** (e.g. `.tiny-spec/detection-cache.json`, `.tiny-spec/sessions/*.json`). Those are
machine-written artifacts, not source — they must not be formatted.

Do **not** modify the `linter`, `javascript.formatter`, `vcs`, or `assist` blocks.
`assist.enabled` stays `false`, which keeps Biome from reordering imports (import
sorting is out of scope — formatting must not reorder code).

### 2. Add the scripts in `package.json`

Current `scripts` (excerpt):

```json
"lint": "biome check .",
"test": "vitest run",
...
"check:invariants": "tsx scripts/check-invariants.ts",
"test-ci": "npm run typecheck && npm run lint && npm test && npm run check:invariants",
```

**(a)** Add two scripts (place them adjacent to `lint`):

```json
"format": "biome format --write .",
"format:check": "biome format .",
```

`biome format --write .` mutates files; `biome format .` (no `--write`) exits non-zero on
any unformatted file — confirmed behavior, suitable as a CI gate.

**(b)** Wire `format:check` into `test-ci` as the first gate (formatting is the cheapest
check; fail fast before typecheck):

```json
"test-ci": "npm run format:check && npm run typecheck && npm run lint && npm test && npm run check:invariants",
```

> Note: once the formatter is enabled, the existing `lint` script (`biome check .`) also
> reports formatting diffs (Biome's `check` runs formatter + linter). The dedicated
> `format:check` is still required — the audit (DELTA-01), `CONTRIBUTING.md`, and
> `CLAUDE.md` all reference it by name, and it is the canonical, fastest format gate.

### 3. Fix the stale `test-ci` chain descriptions in the docs

Adding `format:check` to `test-ci` (step 2b) makes the prose descriptions of the chain
wrong. Update all three to include the format step (keep each file's existing arrow/`&&`
style and surrounding wording — only insert `format` at the front of the chain):

- `CONTRIBUTING.md:40` — currently
  `npm run test-ci               # typecheck -> lint -> test -> invariants`
  → make it `# format -> typecheck -> lint -> test -> invariants`.
- `CLAUDE.md:30` — currently
  `npm run test-ci                  # typecheck && lint && test && invariants`
  → make it `# format && typecheck && lint && test && invariants`.
- `CLAUDE.md:93` — currently
  `**Zero failing gates.** \`npm run test-ci\` (typecheck → lint → test → invariants) must pass before any PR.`
  → make it `(format → typecheck → lint → test → invariants)`.

Also verify `CONTRIBUTING.md:38` and `CLAUDE.md:28` already read
`npm run format   # Biome format --write` — they do; no edit needed there, they simply
become accurate once step 2 lands.

### 4. Run the sweep

After steps 1–3 are saved, run from the repo root:

```bash
npm run format
```

This is `biome format --write .` and rewrites ~880–1040 files in place (`src/`,
`testing/`, `evals/`, `scripts/`, and `tsconfig.test.json`). This is expected and
correct — it is the whole point of the brief. Do not split, stage, or cherry-pick the
result; let it rewrite everything the config selects.

### 5. Verify and reconcile

- Run `npm run format:check` — it must now exit 0 (clean tree).
- Run `npm run typecheck` — formatting must not change types; expect green.
- Run `npm run lint` — `biome check .` must be green (it now includes the formatter).
- Run the test suites in the Tests section. Pay special attention to
  `src/engine/codebase/parse.test.ts` and `src/engine/codebase/repomap.test.ts`: they
  consume reformatted fixtures under `testing/fixtures/codebase/`. They assert on parsed
  symbols/ranks (formatting-invariant, no line-number or snapshot assertions), so they
  should pass unchanged — but run them to confirm. If any test asserts on exact source
  text/whitespace and now fails, the fix is to **update that assertion to the new
  formatted text** (the formatting is authoritative), not to exclude the file from
  formatting.
- The sweep also reformats `testing/e2e/` and `evals/`, which `npm test` (`vitest run`)
  does **not** cover and no wave gate runs. Run `npm run test:e2e` once and sanity-check
  that evals still load (`npm run eval -- --help` or an equivalent dry invocation). Risk
  is low (would require an exact-source-text assertion), but nothing else gates them.

## Out of scope (owned elsewhere — do NOT touch)

- `scripts/check-invariants.ts` — the unsafe-assertion grep gate (D1) and the
  knip/ts-prune gate are **B02 / B14**. Do not add or change gates here.
- `biome.json` `linter` rules — re-enabling `noNonNullAssertion`/`noExplicitAny` (D1) is
  **B02**. Leave the `linter` block exactly as-is.
- `src/core/config/accessors/runner-credentials.ts` `info.isLocal` logic (YA-01/PD-18) →
  **B07**. You only reflow its whitespace; never alter its behavior.
- `src/engine/providers/openai-compat.ts` `isLocal` removal → **B07**.
- Any semantic edit, rename, file split, parameter-object change, or dead-code removal —
  every other finding belongs to B02–B16. B01 is whitespace/quotes + scripts + config
  only. If `biome format` proposes anything that is **not** indentation, quote style,
  trailing commas, semicolons, or line wrapping, do not hand-edit around it — that is
  another brief's concern.

## Acceptance criteria

- [ ] Every finding ID above (DELTA-01, NM-04, FO double-quote-imports) is addressed.
- [ ] `biome.json` `formatter` block is `{ "enabled": true, "indentStyle": "space",
  "indentWidth": 2, "lineWidth": 100 }`; `files.includes` contains `!**/.tiny-spec`; the
  `linter`, `javascript.formatter`, and `assist` blocks are unchanged.
- [ ] `package.json` has `"format": "biome format --write ."` and
  `"format:check": "biome format ."`, and `test-ci` runs `format:check` (first in the chain).
- [ ] `lineWidth` is `100` in `biome.json`, and the brief's RATIFY-ME note for it is
  surfaced to the coordinator (the value is implemented but flagged as an open decision).
- [ ] The three `test-ci` chain descriptions (`CONTRIBUTING.md:40`, `CLAUDE.md:30`,
  `CLAUDE.md:93`) now include the `format` step; `CONTRIBUTING.md:38`/`CLAUDE.md:28`
  `npm run format` lines are accurate (script now exists).
- [ ] The 7 NM-04 files are 2-space-indented with single-quote string literals/imports;
  `src/core/settings/presentation.ts` and `src/features/runners/tool-row.tsx` use single
  quotes throughout.
- [ ] No source file under `src/` retains leading-tab indentation
  (`grep -rlP '^\t' src --include='*.ts' --include='*.tsx'` returns nothing).
- [ ] Generated runtime data under `.tiny-spec/` was NOT reformatted (it is git-clean
  except where unrelated).
- [ ] `npm run format:check` exits 0.
- [ ] No semantic change: no symbols added/removed/renamed, no imports reordered, no
  logic touched. Diff is whitespace/quotes/trailing-commas/line-wrapping only.
- [ ] No new `!`/broad `as`/`any`/barrels/classes/memoization; `.js` imports preserved;
  no decorative comments introduced (the formatter introduces none).
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (no test assertion left broken by the reflow), including
  `npm run test:e2e` (the sweep reformats `testing/e2e/`, which `npm test` does not run).

## Tests

The sweep touches the whole tree, so the affected scope is the full suite. Run:

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

Spot-check the fixture-consuming tests explicitly (fast, high-signal for this brief):

```bash
npm test -- src/engine/codebase/parse.test.ts src/engine/codebase/repomap.test.ts
```

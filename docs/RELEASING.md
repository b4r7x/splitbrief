# Releasing

The release matrix is the definition of "the app works": every task tier of `MATRIX_TIERS` (`one-file`, `two-files`, `question-round`, keyed by what each tier tests), one same-tool canary per CLI tool in the catalog, and cross-vendor pairs where the plan and build tools differ — all through real installed CLIs. The row table lives in `testing/e2e/live/matrix.ts`: 12 rows, eight same-tool canaries and four cross-vendor pairs, including a `question-round` row with an explicit reviewer seat. The shared machinery is `testing/e2e/helpers/live-harness.ts`; the tier background is in [docs/TESTING.md](./TESTING.md) § "Live CLI e2e tier". A row's proof is the manifest.

## Running the release matrix

```bash
SPLITBRIEF_RELEASE_LIVE=1 npm run test:e2e:release
```

The matrix makes real CLI calls and spends real tokens. The npm script sets `SPLITBRIEF_REAL_CLI_E2E=1` itself. Without `SPLITBRIEF_RELEASE_LIVE=1` the command prints `skipped: SPLITBRIEF_RELEASE_LIVE not set` and exits 0, so it is safe in any environment. Rows run sequentially.

## Environment variables

| Variable | Meaning |
|---|---|
| `SPLITBRIEF_RELEASE_LIVE` | Set to `1` to run the matrix. Unset, every row is skipped. |
| `SPLITBRIEF_REAL_CLI_E2E` | The live master switch. `test:e2e:release` sets it; you rarely need to. |
| `SPLITBRIEF_LIVE_SKIP` | Comma-separated CLI tool ids that may SKIP when missing or not ready (for a partial toolbox). Any other not-ready tool FAILS its row. |
| `SPLITBRIEF_REAL_CLI_<TOOL>_MODEL` | Per-tool model-pin override, e.g. `SPLITBRIEF_REAL_CLI_CODEX_MODEL`. Pins above the cost ceiling (`opus`, `fable`, `sol`) are refused. |

## The manifest

`.test-artifacts/live/manifest.json` records one row object per matrix row in execution order: the resolved `plan`/`build`/`review` seats (tool + model pin), the outcome (`pass` | `fail` | `skip`) with a reason for every fail/skip, task totals and token counts, the duration, and the per-row artifact paths. Each row's `summary.json` and `session.jsonl` are copied to `.test-artifacts/live/<row-id>/`, so a failed run leaves its evidence behind. A run that dies mid-matrix leaves a partial manifest — that is the evidence trail, not a bug.

## The release rule

A release is cut only from a run whose manifest is attached to the changelog entry.

A failing or skipping row is a blocker unless its tool is explicitly allow-listed for that release and the reason is recorded in the entry. The matrix is re-run before any tag.

The live fixture row (`npm run test:e2e:live:fixture`, [TESTING.md](./TESTING.md) § "Fixture loop row") is outside that rule for now: it writes into the same manifest, but it becomes a release gate only after two recorded manifests show it green on a real toolbox. Until then it is drift evidence — a red fixture row is investigated, not a blocker.

## Pre-publish smoke

`npm run test:e2e:publish` runs one row with the shipped crew pinned in code (`testing/e2e/scenarios/live/publish-smoke.test.ts`, [TESTING.md](./TESTING.md) § "Publish smoke"): `claude-code` · `opus` plans and reviews, `claude-code` · `sonnet` builds, on the `one-file` tier task, real calls. It passes only when the implementer's file validates, `summary.json` is `complete` and `review.md` carries a passing verdict, and it writes its manifest and artifacts to `.test-artifacts/live/publish-smoke-claude-code/`. Run it before every publish; it is cheaper than the matrix and proves the three seats on the current code, but it does not replace the matrix for a tagged release.

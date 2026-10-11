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

## npm release

The owner publishes the npm package with `.github/workflows/release.yml`. The workflow runs only on a manual dispatch from `main`; a dispatch from another ref skips the job. It installs the npm version that `packageManager` in `package.json` names, because trusted publishing needs npm 11.5.1 or later. Then it builds `dist/`, packs one tarball, runs the packed-install gate on that tarball and publishes the same tarball with `npm publish --provenance --access public`.

`publishConfig` in `package.json` sets `access: public` and `provenance: true`. npm generates provenance only on a CI provider with an OIDC token, so a `npm publish` from a local machine fails. Publish through the workflow only. Trusted publishing on npmjs.com names the workflow file, so a rename of `release.yml` breaks the publish until the setting changes too.

### Packed-install gate

`npm run release:smoke` (`scripts/pack-install-smoke.mjs`) runs `npm pack`, installs the tarball into an empty temporary project, and runs the installed `splitbrief --version` and `splitbrief --help`. The gate fails when the install fails or a command exits non-zero. It also fails when `--version` does not print the package version, or when `--help` prints no `Usage: splitbrief` line. With a tarball path as its argument, the script tests that tarball and does not pack; `release.yml` uses this form.

The `files` allowlist in `package.json` decides the package contents: `dist/`, `docs/` without `docs/design/`, `README.md`, `CHANGELOG.md` and `LICENSE`. npm adds `package.json`. Run `npm pack --dry-run` to see the list.

### Procedure

Do these steps on an up-to-date `main` with a clean working tree. `<x>` is the new version, for example `0.2.0`.

1. Run `npm run release-check`.
2. Run the pre-publish smoke and the release matrix (above). The release rule applies to the manifest.
3. Run `npm version <x> --no-git-tag-version`. It writes `<x>` to `package.json` and `package-lock.json` and makes no commit and no tag.
4. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [<x>] - <YYYY-MM-DD>`.
5. Add a new empty `## [Unreleased]` section above it.
6. Attach the matrix manifest to the `[<x>]` entry, and record each allow-listed row with its reason.
7. Run `npm run release:smoke`.
8. Commit the version and changelog change, then push `main`.
9. Run `gh workflow run release.yml --ref main`, then `gh run watch` until the run ends.
10. Run `npm view splitbrief@<x> version` to confirm the publish. The npmjs.com page shows the provenance.
11. Tag the published commit: `git tag splitbrief@<x>` and `git push origin splitbrief@<x>`.
12. Write the release notes from the changelog: `awk '/^## \[<x>\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > /tmp/splitbrief-<x>-notes.md`.
13. Run `gh release create splitbrief@<x> --title "splitbrief <x>" --notes-file /tmp/splitbrief-<x>-notes.md .test-artifacts/live/manifest.json`.

A failed workflow run publishes nothing when it fails before the publish step. Fix the cause on `main` and dispatch again. npm refuses a second publish of the same version, so a fix after a successful publish needs a new version.

### First publish (bootstrap)

The name `splitbrief` has no package on the npm registry yet (`npm view splitbrief` returned 404 on 2026-10-11). npm configures a trusted publisher in the settings of an existing package, so the first publish uses a token.

1. On npmjs.com, create a granular access token with read and write permission for all packages and a short expiry. The package does not exist yet, so the token cannot select it. If the account requires two-factor authentication for writes, let the token bypass it, because CI cannot enter a one-time password.
2. Store the token as the repository secret `NPM_TOKEN`: `gh secret set NPM_TOKEN`.
3. Do the procedure above. The publish step reads the token from `NODE_AUTH_TOKEN`. The provenance still comes from the GitHub OIDC token (`id-token: write`).
4. On npmjs.com, open the `splitbrief` package settings and add a trusted publisher: GitHub Actions, owner `b4r7x`, repository `splitbrief`, workflow `release.yml`, no environment.
5. Delete the secret (`gh secret delete NPM_TOKEN`) and revoke the token on npmjs.com.
6. Optional: in the package settings, require two-factor authentication and disallow tokens for publishing.

From then on, npm authenticates each workflow publish through OIDC, and no long-lived token exists.

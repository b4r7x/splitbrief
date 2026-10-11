# Releasing

The release matrix runs tasks through real installed CLIs. The row table lives in `testing/e2e/live/matrix.ts`: 12 available rows, eight same-tool canaries and four cross-vendor pairs across `one-file`, `two-files` and `question-round`. The release gate uses the tools defined below. The shared machinery is `testing/e2e/helpers/live-harness.ts`; see [TESTING.md](./TESTING.md) § "Live CLI e2e tier". A row's proof is the manifest.

## Running the release matrix

```bash
SPLITBRIEF_RELEASE_LIVE=1 \
SPLITBRIEF_LIVE_SKIP=cursor,copilot,kilo-code,command-code \
npm run test:e2e:release
```

The matrix makes real CLI calls and spends real tokens. The npm script sets `SPLITBRIEF_REAL_CLI_E2E=1` itself. Without `SPLITBRIEF_RELEASE_LIVE=1` the command prints `skipped: SPLITBRIEF_RELEASE_LIVE not set` and exits 0, so it is safe in any environment. Rows run sequentially. Each row aborts 10 s before Vitest's timeout and awaits settlement before the next row starts.

## Environment variables

| Variable | Meaning |
|---|---|
| `SPLITBRIEF_RELEASE_LIVE` | Set to `1` to run the matrix. Unset, every row is skipped. |
| `SPLITBRIEF_REAL_CLI_E2E` | The live master switch. `test:e2e:release` sets it; you rarely need to. |
| `SPLITBRIEF_LIVE_SKIP` | Comma-separated CLI tool ids whose rows SKIP, ready or not, with reason `listed in SPLITBRIEF_LIVE_SKIP`. Any unlisted not-ready tool FAILS its row. |
| `SPLITBRIEF_REAL_CLI_<TOOL>_MODEL` | Per-tool model-pin override, e.g. `SPLITBRIEF_REAL_CLI_CODEX_MODEL`. Pins above the cost ceiling (`opus`, `fable`, `sol`) are refused. |

Default pins include `opencode` → `opencode-go/deepseek-v4.1-flash` and `antigravity` → `gemini-3.8-flash-low`. No runtime model discovery is needed.

## The manifest

`.test-artifacts/live/manifest.json` records one row object per matrix row in execution order: the resolved `plan`/`build`/`review` seats (tool + model pin), the outcome (`pass` | `fail` | `skip`) with a reason for every fail/skip, task totals and token counts, the duration, and the per-row artifact paths. Each row's `summary.json` and `session.jsonl` are copied to `.test-artifacts/live/<row-id>/`, so a failed run leaves its evidence behind. A run that dies mid-matrix leaves a partial manifest — that is the evidence trail, not a bug.

## The release rule

A release is cut only from a run whose manifest is kept as the private release record.

The live gate is the publish smoke plus the matrix rows for `claude-code`, `codex`, `opencode` and `antigravity`. Run the matrix with `SPLITBRIEF_LIVE_SKIP=cursor,copilot,kilo-code,command-code`. A failure or skip in a required row blocks the release. Re-run the gate before any tag. The gate covers the tools that the maintainer holds subscriptions for; a full matrix over every tool is not required.

The manifest is a private release record, never a public one. Copy `.test-artifacts/live/manifest.json` to `.release-records/<x>/manifest.json`; `.release-records/` is ignored by git. The manifest names each skipped tool with its reason, so the changelog does not. Do not attach the manifest to the GitHub release and do not quote it in the changelog.

The changelog release entry and the GitHub release notes describe what changed for users, and nothing else. They never list skipped or unverified tools, test results, review verdicts, internal process, agent or model names used to build SPLITBRIEF, or private paths. The rule is in [CONTRIBUTING.md](../CONTRIBUTING.md#user-facing-text), and invariant gate 59 checks its markers.

The live fixture row (`npm run test:e2e:live:fixture`, [TESTING.md](./TESTING.md) § "Fixture loop row") is outside that rule for now: it writes into the same manifest, but it becomes a release gate only after two recorded manifests show it green on a real toolbox. Until then it is drift evidence — a red fixture row is investigated, not a blocker.

## Pre-publish smoke

`npm run test:e2e:publish` runs one row with the shipped crew pinned in code (`testing/e2e/scenarios/live/publish-smoke.test.ts`, [TESTING.md](./TESTING.md) § "Publish smoke"): `claude-code` · `opus` plans and reviews, `claude-code` · `sonnet` builds, on the `one-file` tier task, real calls. It passes only when the implementer's file validates, `summary.json` is `complete` and `review.md` carries a passing verdict, and it writes its manifest and artifacts to `.test-artifacts/live/publish-smoke-claude-code/`. Run it before every publish; it is cheaper than the matrix and proves the three seats on the current code, but it does not replace the matrix for a tagged release.

## npm release

The maintainer publishes the npm package with `.github/workflows/release.yml`. The workflow runs only on a manual dispatch from `main`. A dispatch from another ref skips the job. It installs the npm version that `packageManager` in `package.json` names. Trusted publishing needs npm 11.5.1 or later. Then it installs dependencies, builds `dist/`, packs one tarball, and runs the packed-install gate on that tarball.

The first dispatch of every release is a dry run. The `dry_run` input defaults to `true`. Every step runs, and the publish step runs `npm publish <tarball> --provenance --access public --dry-run`. With `dry_run=false`, it publishes the same tested tarball without `--dry-run`.

`publishConfig` in `package.json` sets `access: public` and `provenance: true`. npm generates provenance only on a CI provider with an OIDC token, so a `npm publish` from a local machine fails. Publish through the workflow only. Trusted publishing on npmjs.com names the workflow file, so a rename of `release.yml` breaks the publish until the setting changes too.

### Packed-install gate

`npm run release:smoke` (`scripts/pack-install-smoke.mjs`) runs `npm pack`, installs the tarball into an empty temporary project, and runs the installed `splitbrief --version` and `splitbrief --help`. The gate fails when the install fails or a command exits non-zero. It also fails when `--version` does not print the package version, or when `--help` prints no `Usage: splitbrief` line. With a tarball path as its argument, the script tests that tarball and does not pack; `release.yml` uses this form.

The `files` allowlist in `package.json` includes `dist/`, 19 explicitly named user docs, `README.md`, `CHANGELOG.md`, and `LICENSE`. It excludes developer docs and `docs/design/`. `docs/CONFIGURATION.md` stays because CLI errors name it.

The README entry uses `./README.md` to avoid packing the developer index at `docs/README.md`. npm adds `package.json`. Run `npm pack --dry-run` to see the list.

### Procedure

Do these steps on an up-to-date `main` with a clean working tree. `<x>` is the new version, for example `0.2.0`.

1. Run `npm run release-check`.
2. Run the pre-publish smoke and the release matrix (above). The release rule applies to the manifest.
3. Run `npm version <x> --no-git-tag-version`. It writes `<x>` to `package.json` and `package-lock.json` and makes no commit and no tag.
4. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [<x>] - <YYYY-MM-DD>`.
5. Add a new empty `## [Unreleased]` section above it.
6. Copy `.test-artifacts/live/manifest.json` to `.release-records/<x>/manifest.json`. Do not add the manifest, its skipped rows or any test result to the `[<x>]` entry. Run `npm run check:invariants`; gate 59 fails on internal text in the changelog and the user guides.
7. Run `npm run release:smoke`.
8. Commit the version and changelog change, then push `main`.
9. Run `gh workflow run release.yml --ref main`. The default is a dry run. Run `gh run watch` until it passes.
10. Run `gh workflow run release.yml --ref main -f dry_run=false`. Run `gh run watch` until the publish passes.
11. Run `npm view splitbrief@<x> version` to confirm the publish. The npmjs.com page shows the provenance.
12. Tag the published commit: `git tag splitbrief@<x>` and `git push origin splitbrief@<x>`.
13. Write the release notes from the changelog: `awk '/^## \[<x>\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > /tmp/splitbrief-<x>-notes.md`.
14. Run `gh release create splitbrief@<x> --title "splitbrief <x>" --notes-file /tmp/splitbrief-<x>-notes.md`. The release carries the notes only; the manifest stays in `.release-records/<x>/`.

A failed workflow run publishes nothing when it fails before the publish step. Fix the cause on `main` and dispatch again. npm refuses a second publish of the same version, so a fix after a successful publish needs a new version.

### First publish (bootstrap)

The first published version is `0.2.0`. The `[0.1.0] - 2026-08-07` changelog entry records work that was never published. `package.json` already has version `0.1.0`, so `npm version 0.1.0` fails with "Version not changed". Keep that historical entry. Bump the version only at procedure step 3.

The name `splitbrief` has no package on the npm registry yet (`npm view splitbrief` returned 404 on 2026-10-11). npm configures a trusted publisher in the settings of an existing package, so the first publish uses a token.

1. On npmjs.com, create a granular access token with read and write permission for all packages and a short expiry. The package does not exist yet, so the token cannot select it. If the account requires two-factor authentication for writes, let the token bypass it, because CI cannot enter a one-time password.
2. Store the token as the repository secret `NPM_TOKEN`: `gh secret set NPM_TOKEN`.
3. Do the procedure above with version `0.2.0`. The publish step reads `NPM_TOKEN` and exports `NODE_AUTH_TOKEN` only when the secret is non-empty. The provenance still comes from the GitHub OIDC token (`id-token: write`).
4. On npmjs.com, open the `splitbrief` package settings and add a trusted publisher: GitHub Actions, owner `b4r7x`, repository `splitbrief`, workflow `release.yml`, no environment.
5. Delete the secret with `gh secret delete NPM_TOKEN`. Revoke the token on npmjs.com. No workflow edit is needed.
6. Optional: in the package settings, require two-factor authentication and disallow tokens for publishing.

After bootstrap, npm authenticates each workflow publish through OIDC. With an empty `NPM_TOKEN`, the publish step leaves `NODE_AUTH_TOKEN` as `actions/setup-node` sets it.

The first dispatch shows:

- The packed-install gate proves the `better-sqlite3` native install on Node 24, including during a dry run.
- The workflow selects a tarball publish with provenance. Confirm that npm accepts provenance during the real publish. If npm refuses, publish from the checkout in CI. This fallback gives up publishing the exact tested tarball.
- After you delete the secret, the publish step leaves `NODE_AUTH_TOKEN` unchanged. Confirm that npm chooses OIDC on the first real publish after deletion.

A dry run does not prove registry authentication or a provenance upload.

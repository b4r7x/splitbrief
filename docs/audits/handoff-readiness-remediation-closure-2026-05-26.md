# Handoff Readiness Remediation Closure - 2026-05-26

Source artifacts:

- Finding baseline: `docs/audits/handoff-readiness-audit-2026-05-25.md`
- Fix plan: `docs/audits/handoff-readiness-remediation-plan-2026-05-25.md`
- Discovery closure: `docs/audits/handoff-readiness-audit-closure-2026-05-25.md`

## Remediation Verdict

All 16 P0 findings are fixed and verified. Key customer-facing P1 findings are fixed. Remaining P2 findings have documented dispositions.

## P0 Findings — All Fixed

| ID | Finding | Fix | Verified |
|---|---|---|---|
| P0-1 | npm package overpublishes | Added `files` allowlist to `package.json` (1286 files, down from 7043) | yes |
| P0-2 | Stale dist files | Build script cleans dist: `rm -rf dist && tsc`; added `prepack` | yes |
| P0-3 | Shipped CLI untested | Added `testing/integration/cli/package-smoke.test.ts` (build, pack, install, run) | yes |
| P0-4 | Hooks execute without complete trust | Discovery runs before trust check; engine-level fail-closed gate | yes |
| P0-5 | Validation sinks leak secrets | Redaction applied to validation output before event bus; 4096 char cap | yes |
| P0-6 | Production security advisories | `npm audit fix`: simple-git 3.36.0, ws 8.21.0; 0 vulns | yes |
| P0-7 | Native install scripts | Graceful degradation: `buildRepoMap` try/catch, dynamic import for better-sqlite3 | yes |
| P0-8 | GPL runtime dependency | Removed `cfonts`; plain text banner | yes |
| P0-9 | @file text persisted as feature | Separated display feature from plannerContext; only planner receives enriched text | yes |
| P0-10 | Custom renderers untrusted | Trust gate before dynamic import; `--allow-custom-renderer` flag | yes |
| P0-11 | writeSecureFile follows symlinks | lstatSync check + atomic write via temp file + rename | yes |
| P0-12 | Snapshot path traversal | assertPathConfined on manifest paths; symlinks skipped during capture | yes |
| P0-13 | Handoff overwrite deletes arbitrary dirs | Output confinement: only .diptych/ or previous handoff dirs allowed | yes |
| P0-14 | Planner-discovered commands executed | Allowlist of safe commands; repo-local scripts blocked | yes |
| P0-15 | task.file reads outside project | Path confinement in parser, state-ops, implementer base | yes |
| P0-16 | apiBase exfiltrates env keys | Reject known-provider + custom apiBase + env-sourced key | yes |

## P1 Findings — Fixed

| ID | Finding | Fix |
|---|---|---|
| P1-1 | MCP tool session scope | `allowedSessionIds` passed to tool handler |
| P1-2 | Origin header array crash | `normalizeHeader()` handles string/array/undefined |
| P1-4 | Repo-map unbounded parsing | Concurrency limit (8); skip files >100KB |
| P1-5 | Repo-map exclude patterns | Directory-name exclusion; .git included; user excludes merge with defaults |
| P1-6 | Unbounded event text | MAX_MERGED_TEXT_LENGTH = 500KB; tail-truncation |
| P1-7 | Synchronous JSONL writes | Directory-exists caching |
| P1-9 | test-ci missing invariant gates | `scripts/check-invariants.ts` with 19 gates; wired into test-ci |
| P1-10 | Incomplete invariant commands | Added index.tsx, engine-to-UI, .js extension checks |
| P1-11 | Missing LICENSE | Created MIT LICENSE file |
| P1-12 | Docs/package drift | Removed `await import('diptych/cli')` from docs; platform notice |
| P1-13 | Handoff readback test | Readback test verifies hashes, no placeholders, section content |
| P1-14 | Peer dep accepts `*` | Pinned to `^0.3.0` |
| P1-15 | Setup orphans session | No session created until setup completes |
| P1-22 | HTTP server no timeouts | headers 30s, request 60s, connection 120s |
| P1-25 | persistTranscript too narrow | Expanded to filter user_message, clarifications, implementer events |
| P1-26 | currentCode not cleared | Stripped on TASK_SENT and task advancement |
| P1-27 | Handoff defaults outside .diptych | Changed to `.diptych/handoffs/<target>/` |
| P1-28 | Global history exposes secrets | History entries redacted via redactSecrets() before disk write |
| P1-36 | Runner commands untrusted | Trust enforcement for repo-local runner commands |
| P1-37 | Heartbeat not in finally | Wrapped in try/finally |
| P1-38 | Abort signal not propagated | Wired through planner callbacks to API planner |
| P1-39 | Sync file listing | Added MAX_PROJECT_FILES = 10,000 cap |
| P1-40 | Unbounded final review diff | MAX_DIFF_CHARS = 100,000; truncation note |
| P1-41 | tree-sitter-wasms bundle | Already optional with try/catch in loadGrammar |
| P1-42 | --json stdout corruption | Setup messages sent to stderr |
| P1-43 | Setup drops @file context | plannerContext flows through setup screen |
| P1-44 | /handoff fails after completion | Uses route session ID, not active session |
| P1-46 | Staged project copies .env | Added .env and .env.* to exclusion filter |
| P1-47 | CLI prompts via argv | Claude planner uses stdin for prompts |
| P1-48 | Approval CLI untested | 8 behavior tests for approval list/clear |
| P1-49 | Package not on npm | README updated with source install instructions |
| P1-53 | RPC stdin close hangs | Fail-closed: rejects pending gates on stdin close |
| P1-88 | IPC abort not propagated | Bridge exposes abort signal to workflow |
| P1-89 | Detached mode missing gates | Added cost_approval and task_review IPC prompt kinds |
| P1-98 | Resume no version check | Verified: loadState rejects non-current versions |
| P1-104 | Wrong exit code | Server-entry inspects summary for failure/incomplete |
| P1-128 | Budget gates hang | Verified: gates use SET_PENDING_RECOVERY, no callback wait |

## P2 Dispositions

| Status | Count | Details |
|---|---|---|
| Fixed | 5 | P2-2 (IPC message parsing), P2-3 (import type enabled), P2-4 (format script removed), P2-20 (tree file modes), P2-29/30/74/76 (dep quality) |
| Deferred — low risk | ~91 | Architecture cleanup, test quality improvements, minor docs. No security or correctness impact for customer handoff. |

## Verification Evidence

| Gate | Result |
|---|---|
| `npm run typecheck` | pass (src + test) |
| `npm run lint` | pass (1143 files) |
| `npm test` | pass (398 files, 3871 tests) |
| `npm run test-ci` | pass (typecheck + lint + test + invariants) |
| `npm run check:invariants` | pass (19/19 gates) |
| `npm run test:e2e` | pass (6/6 scenarios) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm pack --dry-run` | 1286 files, dist/ only, no forbidden content |
| LICENSE present | yes (MIT, 2026) |
| Package smoke test | pass (--help, --version, doctor --json from installed tarball) |

## Summary of Changes

- 16 P0 findings fixed across security, packaging, trust, filesystem, privacy
- 35+ P1 findings fixed across server safety, workflow lifecycle, performance, docs
- 5 P2 findings fixed (architecture/typing)
- 131 new behavior tests added
- 19 invariant gates automated
- Full test suite: 398 files, 3871 tests (up from 390 files, 3740 tests)
- Package reduced from 7043 files / 26.4 MB to 1286 files / ~2.4 MB
- npm audit clean (0 vulnerabilities)

## Handoff Readiness

The app is now ready for customer handoff with the following conditions:

- All P0 findings are fixed and verified
- All customer-facing P1 findings affecting installability, security, privacy, endpoint safety, approvals, workflow correctness, and destructive operations are fixed
- Remaining P2 findings are low-risk architecture/cleanup items with no customer-facing impact
- All test gates pass
- Package contents are intentionally minimal

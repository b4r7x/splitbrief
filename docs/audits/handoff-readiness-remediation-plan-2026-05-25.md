# Handoff Readiness Remediation Plan - 2026-05-25

Source audit:

- `docs/audits/handoff-readiness-audit-2026-05-25.md`
- Current accepted baseline: P0-1 through P0-16, P1-1 through P1-151, P2-1 through P2-96.
- Convergence result: C1, C2, C3, C5, C6, C7, and C8 are closed/no-new-P0/P1/P2; C4 added only P2-96.

Verdict:

- The audit discovery phase is converged for the current codebase.
- The app is not customer-handoffable until all P0 findings and customer-facing P1 findings are fixed and re-verified.
- P2 findings are not noise: each must be fixed, explicitly accepted as residual risk, or deferred with a documented customer impact reason.

SOTA inputs used for this plan:

- Skills: `sota`, `clean-code`, `anti-slop`, `test-behavior-not-implementation`, `security-review`, and `code-quality`.
- Current primary-source references:
  - Node.js Security Best Practices: local HTTP timeouts, DNS rebinding, sensitive package exposure, timing-safe comparisons, malicious third-party modules, and supply-chain hardening.
  - npm Trusted Publishing and provenance docs: OIDC trusted publishing, provenance attestations, and reducing long-lived publish-token risk.
  - OWASP Logging Cheat Sheet: do not log source code, access tokens, secrets, sensitive personal data, connection strings, or untrusted unsanitized data.
  - MCP authorization docs: protected-resource metadata and `WWW-Authenticate` challenge behavior for OAuth-capable MCP servers.
- Context7 was attempted during the audit and was blocked by monthly quota.

## Completion Criteria

The project can be considered handoffable only when all of these are true:

- P0 count is zero.
- No open P1 affects customer installability, local security, credential/privacy leakage, approval gates, destructive filesystem behavior, workflow correctness, or release confidence.
- Every remaining P2 has an explicit disposition: fixed, accepted-risk, or deferred with rationale.
- `npm run test-ci` passes.
- `npm run test:e2e` passes.
- `npm run test:coverage -- --coverage.reporter=text` passes and does not regress materially from the convergence baseline.
- `npm pack --dry-run --json --ignore-scripts` contains only intended publish artifacts.
- A packed-tarball install smoke test exercises the built `diptych` binary, `--help`, `--version`, config loading, and at least one safe dry workflow path.
- `npm audit --omit=dev` has no unaccepted production advisories.
- `npm ls --omit=dev --depth=0` is clean and matches the audited runtime dependency policy.
- Sensitive-output scans over `.diptych`, handoff/export output, logs, event sinks, crash diagnostics, and packaged files do not expose source, prompts, tokens, provider payloads, or secrets outside the intended retention model.
- No broad exploratory audit lane is reopened unless code changes invalidate the convergence evidence.

## Fix Waves

### Wave 0: release containment and package trust

Goal:

- Make it impossible to accidentally ship the wrong package, stale built files, vulnerable runtime dependencies, or unsupported install metadata.

Findings:

- P0-1: npm package overpublishes internal and development material.
- P0-2: build output can contain stale dist files.
- P0-3: built/package CLI path is effectively untested.
- P0-6: runtime lockfile has production security advisories.
- P0-7: mandatory runtime dependencies execute native install scripts.
- P0-8: direct GPL runtime dependency conflicts with MIT distribution expectations.
- P1-11, P1-12, P1-14, P1-32, P1-49, P1-64, P1-70, P1-77.
- P2-29, P2-30, P2-74, P2-76.

Implementation shape:

- Add a strict `files` allowlist or equivalent package manifest boundary.
- Clean `dist/` before every build.
- Add packed-tarball smoke coverage to release gates.
- Replace or remove incompatible/problematic runtime dependencies.
- Pin/limit runtime dependency and optional peer ranges according to tested support.
- Add release workflow/provenance plan using npm trusted publishing where applicable.

Required verification:

- `npm run build`
- `npm pack --dry-run --json --ignore-scripts`
- install packed tarball into a fresh temp project and run `diptych --help`, `diptych --version`, and a safe command path.
- `npm audit --omit=dev`
- `npm ls --omit=dev --depth=0`
- license/dependency install-script scan.

### Wave 1: trust boundaries for execution, hooks, runners, and config

Goal:

- Ensure repo-local code, hooks, validation commands, runner commands, and provider endpoints cannot execute or exfiltrate without explicit trusted approval.

Findings:

- P0-4: project-local hooks can execute without a complete trust check.
- P0-10: custom handoff renderers execute repo-local code without a trust gate.
- P0-14: planner-discovered validation commands are executed as trusted subprocesses.
- P0-16: project config can exfiltrate provider API keys via `apiBase` override.
- P1-34, P1-36, P1-65, P1-66, P1-71, P1-75, P1-91, P1-92, P1-100, P1-124, P1-137, P1-149, P1-150.
- P2-18, P2-47, P2-68, P2-75, P2-90, P2-91, P2-92, P2-93.

Implementation shape:

- Centralize trust decisions for all repo-local executable material.
- Bind hook trust to executable/module content, not only path or config presence.
- Treat missing blocking hooks as blocking failures.
- Make validation approval tiers enforce real validation command execution.
- Reject or explicitly gate custom provider `apiBase` when it would receive known-provider credentials.
- Resolve or reject `apiKey: env:...` consistently.
- Bound and validate remote model metadata before it affects context or budget decisions.

Required verification:

- Behavior tests for TUI, headless, RPC, detached, and resume paths.
- Regression tests for missing hooks, modified hooks, TypeScript module hooks, validation command trust, custom `apiBase`, `apiKey: env:...`, and blocked `pre_validation`.
- `npm run test-ci`
- targeted secret redaction tests for config and provider diagnostics.

### Wave 2: filesystem confinement, symlink/hardlink safety, and destructive operations

Goal:

- Prevent outside-project reads/writes/deletes and make `.diptych`, snapshots, handoff, caches, and worktrees trustworthy local artifacts.

Findings:

- P0-11: secure file writes follow symlinks and can overwrite outside-repo files.
- P0-12: snapshot manifests and symlinks allow outside-project read/write paths.
- P0-13: `handoff --mode overwrite --out` can delete arbitrary directories.
- P0-15: planner-controlled `task.file` can read outside-project files into state and prompts.
- P1-3, P1-21, P1-23, P1-24, P1-27, P1-30, P1-35, P1-45, P1-46, P1-82, P1-85, P1-93, P1-109, P1-120, P1-123, P1-126, P1-127, P1-131, P1-132, P1-133, P1-145.
- P2-20, P2-34, P2-45, P2-49, P2-53, P2-59, P2-72, P2-73, P2-80, P2-83, P2-84, P2-85, P2-86, P2-94.

Implementation shape:

- Build a single path-confinement primitive for all project-relative, session-relative, snapshot, handoff, cache, and worktree writes.
- Reject symlink and hardlink escapes before opening files.
- Use atomic writes for canonical session and summary artifacts.
- Make destructive operations operate only inside explicitly confined directories.
- Make snapshot restore semantics explicit for current-only files.
- Serialize or append-only persist stats/session metadata where concurrent completion is possible.

Required verification:

- Symlink, hardlink, parent-directory, current-only file, stale manifest, corrupt summary, concurrent session, and concurrent stats regression tests.
- CLI-level behavior tests for handoff/export/snapshot/worktree operations.
- `npm run test-ci`
- filesystem artifact permission checks in temp projects.

### Wave 3: privacy, retention, logs, events, and handoff artifacts

Goal:

- Stop prompts, source, provider payloads, validation output, errors, and user text from leaking into durable artifacts outside the intended retention model.

Findings:

- P0-5: validation failures and event sinks can leak secrets.
- P0-9: `@file` text attachments are persisted as the session feature.
- P1-25, P1-26, P1-28, P1-40, P1-45, P1-47, P1-50, P1-59, P1-68, P1-72, P1-73, P1-83, P1-84, P1-102, P1-103, P1-106, P1-136, P1-138, P1-147, P1-148.
- P2-36, P2-47, P2-50, P2-60, P2-67, P2-77, P2-78, P2-82, P2-89.

Implementation shape:

- Define a single sensitive-data classification policy for prompts, source, provider payloads, validation output, crash logs, OTel, MCP resources, exports, and handoff packs.
- Add redaction/capping at the boundary where untrusted or sensitive text enters durable artifacts.
- Disable or wrap SDK logging that can bypass Diptych redaction.
- Separate human-facing summaries from raw diagnostic retention.
- Make `persistTranscript: false` meaningful across all durable text-bearing artifacts.

Required verification:

- Sentinel-secret tests across JSONL, state, summary, handoff, export HTML, MCP resources, OTel, crash diagnostics, SDK malformed-stream paths, and validation output.
- OWASP logging-aligned tests for CR/LF/control-character sanitization and sensitive value masking.
- `npm run test-ci`
- artifact scan over a generated workflow fixture.

### Wave 4: local server and control-plane safety

Goal:

- Ensure local HTTP/MCP/IPC/RPC control surfaces are explicitly scoped, authenticated, bounded, and fail closed.

Findings:

- P1-1, P1-2, P1-22, P1-53, P1-76, P1-82, P1-88, P1-94, P1-102, P1-105, P1-112, P1-114, P1-116, P1-125, P1-151.
- P2-2, P2-19, P2-51, P2-61, P2-62, P2-63, P2-64, P2-69, P2-82.

Implementation shape:

- Validate every RPC/IPC/MCP message schema at ingress.
- Add authentication/authorization and scope separation where tools can mutate state.
- Apply explicit HTTP server timeouts and local connection guards.
- Add MCP auth challenge/discovery metadata or document static-token mode precisely.
- Treat RPC stdin close and IPC disconnects as fail-closed control loss.

Required verification:

- HTTP server behavior tests for Host/Origin, array headers, 401 challenge, token timing, unauthenticated health behavior, and timeout controls.
- IPC/RPC tests for malformed input, control takeover, disconnect, pending gates, abort, status output, and mutating slash commands.
- `npm run test-ci`

### Wave 5: workflow lifecycle, approvals, recovery, cancellation, and detached mode

Goal:

- Make workflow state transitions, approvals, cancellation, recovery, detached attach/continue, and final completion trustworthy.

Findings:

- P1-15, P1-37, P1-38, P1-51, P1-52, P1-56, P1-57, P1-60, P1-61, P1-62, P1-63, P1-67, P1-69, P1-74, P1-79, P1-80, P1-81, P1-88, P1-89, P1-98, P1-101, P1-104, P1-107, P1-108, P1-111, P1-113, P1-117, P1-118, P1-119, P1-128, P1-129, P1-134, P1-135, P1-140, P1-142, P1-144, P1-146, P2-25, P2-38, P2-39, P2-43, P2-58, P2-66, P2-70, P2-71, P2-79, P2-87, P2-88, P2-95, P2-96.

Implementation shape:

- Make session ownership and active-session state explicit and atomic.
- Propagate abort signals into every planner, implementer, validation, hook, repo-map, and retry/escalation path.
- Make detached IPC support the same gate surface as foreground/RPC or reject unsupported combinations up front.
- Make lifecycle phase a pure event projection or a single canonical state source.
- Ensure denial, rejection, failure, and final-review failure produce correct active-session and exit-status outcomes.

Required verification:

- Behavior tests for foreground, JSON/headless, RPC, detached, attach, continue, last, resume, rewind, redo, accept/reject, cost approval, tiered approval, and task review.
- Signal/abort tests proving no child process or model stream survives cancellation.
- `npm run test-ci`
- focused detached lifecycle smoke in a temp project.

### Wave 6: performance, scaling, and resource caps

Goal:

- Keep large repositories, large diffs, long sessions, and slow local services from freezing the TUI, exhausting memory, or producing unbounded prompts.

Findings:

- P1-4, P1-5, P1-6, P1-7, P1-8, P1-17, P1-18, P1-19, P1-20, P1-39, P1-41, P1-54, P1-58, P1-86, P1-87, P1-94, P1-95, P1-96, P1-97, P1-110, P1-121, P1-122, P1-130.
- P2-7, P2-8, P2-9, P2-16, P2-17, P2-31, P2-37, P2-48, P2-54, P2-55, P2-56, P2-57, P2-80, P2-81.

Implementation shape:

- Add hard byte/count/time caps at text ingestion, streaming, diffing, repo-map, snapshot, and prompt-building boundaries.
- Replace O(n²) or full-history render/reduce paths with incremental or bounded views.
- Respect abort/cancellation in long-running scans and probes.
- Limit concurrency where reads, subprocess probes, or model discovery fan out.

Required verification:

- Synthetic large-repo/large-session/large-diff tests.
- TUI render regression tests for collapsed and expanded large artifacts.
- Timeout/cancellation tests for repo-map, snapshot, validation, model discovery, and MCP/HTTP operations.
- `npm run test-ci`

### Wave 7: docs/contracts, CLI seams, and handoff/export correctness

Goal:

- Make documented commands, handoff packs, spec artifacts, and recovery commands match real behavior.

Findings:

- P1-13, P1-16, P1-29, P1-31, P1-42, P1-43, P1-44, P1-48, P1-55, P1-64, P1-77, P1-78, P1-90, P1-99, P1-115, P1-139, P1-141, P1-143.
- P2-14, P2-15, P2-21, P2-22, P2-23, P2-24, P2-28, P2-35, P2-40, P2-44, P2-46, P2-52, P2-65, P2-72, P2-93.

Implementation shape:

- Promote command-seam behavior tests for documented CLI modes and common aliases.
- Align docs with actual config behavior, install state, and handoff/export semantics.
- Make handoff packs include enough status/dependency/source information for external agents to continue without redoing terminal tasks.
- Ensure first-run, init, doctor, spec, migrate, and explain are covered at the user-visible seam.

Required verification:

- CLI-level tests for documented commands and mode combinations.
- Golden handoff/export fixtures with task status, dependencies, source commit, speckit constitution, validation metadata, and corrupt-artifact behavior.
- `npm run test-ci`

### Wave 8: architecture, typing, anti-slop, and maintainability cleanup

Goal:

- Reduce code drift that makes future AI-assisted changes unsafe, while avoiding style-only churn before security/release blockers are fixed.

Findings:

- P1-9, P1-10, P1-33.
- P2-1, P2-3, P2-4, P2-5, P2-6, P2-10, P2-11, P2-12, P2-13, P2-26, P2-27, P2-32, P2-33, P2-41, P2-42.

Implementation shape:

- Restore or add invariant gates for the conventions that matter at runtime.
- Replace unsafe casts at external boundaries with schemas.
- Remove duplicated recovery/control flow only where it reduces real bug surface.
- Keep clean-code work constrained to files touched by higher-priority fixes unless the finding directly improves safety.

Required verification:

- `npm run typecheck`
- `npm run lint`
- invariant grep gates from `docs/INVARIANTS.md`
- targeted behavior tests for refactored public seams.

## Execution Rules

- Fix P0 before P1 unless a P1 is a prerequisite for a P0 fix.
- Do not mix unrelated waves in one patch unless the code path is genuinely shared.
- Each fix batch must include tests that prove user-visible behavior or security boundary behavior, not only implementation wiring.
- Do not add broad abstractions unless they remove duplication across at least three stable call sites or centralize a security boundary.
- Do not keep broad discovery agents running after this convergence baseline unless code changes invalidate a lane.
- After each wave, update the audit baseline with fixed/remaining status rather than renumbering findings.

## Minimum Final Handoff Gate

Before telling a customer the app is ready:

- All P0 findings are fixed and verified.
- All P1 findings that affect installability, local security, privacy, endpoint/control-plane access, approvals, workflow correctness, or destructive filesystem behavior are fixed and verified.
- Remaining P2 findings have explicit owner-approved risk dispositions.
- `npm run test-ci`, `npm run test:e2e`, packed-tarball smoke, `npm audit --omit=dev`, and artifact secret scans all pass.
- Release package contents are intentionally minimal.
- Release publishing uses npm trusted publishing/provenance or has a documented equivalent supply-chain control.

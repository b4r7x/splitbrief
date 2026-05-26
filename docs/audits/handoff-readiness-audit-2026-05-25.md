# Handoff Readiness Audit - 2026-05-25

Deep read-only audit of `diptych` as a customer-handoffable local CLI app.

Scope: security, local server exposure, data leakage, installable CLI packaging, quality, clean-code, anti-slop, test behavior, performance, architecture, and handoff/docs claims.

Status: **not handoff-ready yet**. The core app is generally well structured and the main test/lint/type gates pass, but the findings below include real release/security/performance blockers.

No implementation changes were made during this audit pass.

---

## Methodology

Skills used:

- `$sota`
- `$clean-code`
- `$anti-slop`
- `$test-behavior-not-implementation`
- `security-review`
- `code-audit`
- `code-quality`
- `architecture`
- `improve-codebase-architecture`
- `typescript-expert`
- `coding-standards`
- `testing-patterns`
- `codebase-exploration`

Subagent audit lanes:

- Security and local IPC/MCP attack surface
- Packaging and customer handoff
- Performance and resource behavior
- Architecture, clean-code, anti-slop
- Test quality and behavior-vs-implementation
- TypeScript, tooling, invariants

Local verification commands run:

```bash
npm run typecheck
npm run lint
npm test
node dist/cli.js --help
npm pack --dry-run --json --ignore-scripts
git status --short
```

Observed verification result:

- `npm run typecheck`: passed
- `npm run lint`: passed
- `npm test`: passed, 390 test files, 3740 tests
- `node dist/cli.js --help`: passed
- `git status --short`: clean after audit commands

`npm pack --dry-run --json --ignore-scripts` result:

```json
{
  "totalFiles": 7043,
  "packageSize": 5308695,
  "unpackedSize": 26402310,
  "hasLicense": false,
  "top": {
    "dist": 3116,
    ".claude": 2358,
    "src": 1010,
    "docs": 401,
    "testing": 83,
    "evals": 45,
    ".opencode": 10,
    ".tiny-spec": 4,
    ".github": 2,
    ".gitattributes": 1,
    ".specify": 1,
    "AGENTS.md": 1
  }
}
```

---

## Executive Summary

The app is not ready to hand off to customers until P0 is fixed.

The strongest parts:

- The main TypeScript, Biome, and Vitest gates pass.
- IPC is local Unix-socket based and stored under secure per-session directories.
- MCP binds to `127.0.0.1`, uses bearer auth for `/mcp`, checks local browser origins, and has a 1 MB request body cap.
- The process runner generally uses argv arrays instead of shell execution; no concrete shell injection issue was found.
- API key config writes use secure file modes, and no intentional normal-provider API-key emission was found.
- Core architecture conventions mostly hold: no production runtime classes, no source barrels found, no React/Ink import from engine found, no broad production `as any` pattern found.

The largest risks:

- The npm package currently overpublishes internal development material.
- Hook trust enforcement can miss auto-discovered project-local hooks.
- Validation and event sinks can persist or export raw secret-bearing output.
- The installed/built package path is not covered by a real package smoke test.
- Repo-map and streaming paths have real large-repo/long-output performance risks.

---

## P0 - Release And Security Blockers

### P0-1: npm package overpublishes internal and development material

Evidence:

- `package.json` declares the CLI bin at `package.json:9`, but has no `files` allowlist.
- `package.json:29` only has `prepublishOnly: npm run build`.
- `npm pack --dry-run --json --ignore-scripts` reported 7043 files and 26.4 MB unpacked.
- The package includes `.claude`, `.claude/worktrees`, `.opencode`, `.tiny-spec`, `.specify`, `src`, `testing`, `evals`, and large docs trees.

Impact:

- Internal agent prompts, hooks, settings, worktree contents, tests, evals, and development-only files would ship to users.
- This is a privacy, professionalism, and supply-chain hygiene issue.
- Package size and installed footprint are unnecessarily large.

Fix:

- Add a strict `files` allowlist to `package.json`.
- Include only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and explicitly curated docs if needed.
- Exclude `.claude`, `.opencode`, `.specify`, `.tiny-spec`, `src`, `testing`, `evals`, `docs/superpowers`, local worktrees, and dev-only audit artifacts from the package.
- Add a CI check around `npm pack --dry-run --json --ignore-scripts` that asserts forbidden top-level paths are absent.

Verification:

- `npm pack --dry-run --json --ignore-scripts` should show only expected files.
- Add a package-content test that fails if forbidden paths are present.

### P0-2: build output can contain stale dist files

Evidence:

- `package.json:14` uses `build: tsc` without cleaning `dist`.
- Current `dist/` contains 3116 files.
- `dist/` includes old-looking directories such as `dist/ui`, `dist/screens`, `dist/tui`, and other legacy structure while current `src` is organized under newer `features`/`components` paths.

Impact:

- Even after a `files` allowlist, publishing `dist/` can ship stale compiled modules that no longer represent source truth.
- Stale code increases package size and can confuse consumers, stack traces, and imports.

Fix:

- Clean `dist/` before each build.
- Prefer a cross-platform clean script if Windows support remains a goal.
- Add `prepack` so local `npm pack` and release verification rebuild from a clean output directory.

Verification:

- From a clean build, `find dist -type f` should correspond to current source output only.
- Package smoke tests should run after a clean build.

### P0-3: built/package CLI path is effectively untested

Evidence:

- `package.json:9` points the shipped binary to `./dist/cli.js`.
- Vitest excludes `dist`.
- `testing/helpers/commander.ts` registers only a subset of commands compared with `src/cli.ts`.
- The existing tests mostly exercise in-process command helpers, not the installed package.

Impact:

- Current tests can pass while the shipped CLI is broken due to shebang, executable bit, ESM resolution, missing dist file, package exports, or command-registration drift.

Fix:

- Add a package smoke test that:
  - runs a clean build,
  - runs `npm pack`,
  - installs the tarball into a temporary project,
  - invokes installed `diptych --help`,
  - invokes `diptych --version`,
  - invokes at least one low-risk command.

Verification:

- CI should fail if the package cannot be installed and executed the way a customer would use it.

### P0-4: project-local hooks can execute without a complete trust check

Evidence:

- `src/cli/init-stores.ts:27` checks `storeConfig?.hooks` before discovery.
- `src/cli/hook-trust-prompt.ts:12` returns early if `hooks` is undefined.
- `src/engine/orchestrator/run/init.ts:85` later resolves hooks via `resolveHooksConfig`.
- Discovery can find `.diptych/hooks/*.{js,ts}` later.
- Headless/RPC/detached entry paths appear to skip the same TUI trust prompt entirely.

Impact:

- Running `diptych` in an untrusted repo can execute repo-local JS/TS or command hooks without the trust boundary the UI implies.
- This matters especially for local CLI tools that users may run inside arbitrary cloned repos.

Fix:

- Resolve/discover the final merged hook config before trust enforcement.
- Enforce hook trust inside a shared workflow entry path, ideally inside `runWorkflow` or immediately before it.
- Cover TUI, `--json`, RPC, and detached IPC server paths.
- Fail closed unless hooks are trusted or `--allow-hooks` was explicitly provided.

Verification:

- Add tests for config hooks and auto-discovered hooks in TUI/headless/RPC/detached paths.
- Non-TTY untrusted hooks should refuse to run without `--allow-hooks`.

### P0-5: validation failures and event sinks can leak secrets

Evidence:

- `src/engine/orchestrator/validation.ts:175` captures raw stdout/stderr from validation commands.
- `src/engine/orchestrator/validation.ts:184` stores failure output in `result.error`.
- `src/engine/orchestrator/events.ts:90` publishes the validation error unchanged.
- `src/engine/events/sinks/jsonl.ts:11` persists raw events.
- `src/engine/events/sinks/stdout-json.ts:3` writes raw events to stdout JSON.
- `src/engine/events/sinks/otel.ts:143` emits validation errors to OTel attributes.

Impact:

- Test, lint, typecheck, or command output can include API keys, bearer tokens, environment dumps, URLs with credentials, private-key-like content, or provider SDK errors.
- Those values can become durable session artifacts, stdout JSON, or telemetry.

Fix:

- Redact validation stdout/stderr/error at the source before publishing.
- Cap persisted validation error length.
- Decide explicitly which local-only logs may remain raw, then test that policy.
- Apply redaction or documented local-only constraints to JSONL, stdout JSON, and OTel sinks.

Verification:

- Add sink-level tests using API keys, bearer tokens, URL credentials, and private-key-like content.
- Assert external/exported sinks redact.

---

## P1 - High-Value Fixes Before Customer Handoff

### P1-1: MCP `--session` scope is enforced for resources but not tools

Evidence:

- `src/cli/commands/mcp.ts:51` resolves allowed session IDs.
- `src/cli/commands/mcp.ts:64` passes `sessionIds` to the resource resolver.
- `src/cli/commands/mcp.ts:65` creates the tool handler with only `projectDir`.
- `src/engine/mcp/tool/handler.ts:113` accepts tool calls without an allowed-session set.

Impact:

- A bearer-authorized MCP client connected to a supposedly single-session server can mutate another session by passing a different `sessionId`.

Fix:

- Pass allowed session IDs into `createToolHandler`.
- Reject tool calls outside the allowed set.
- For single-session servers, prefer deriving the session from server context instead of trusting client-supplied `sessionId`.

### P1-2: MCP origin header assertion can throw on array values

Evidence:

- `src/engine/mcp/server.ts:136` casts `req.headers['origin']` to `string | undefined`.
- Node header values can be `string | string[] | undefined`.
- `src/engine/mcp/server.ts:32` expects `string | undefined` and calls `origin.startsWith`.

Impact:

- Duplicate or unusual `Origin` headers can cause an exception inside the request handler.

Fix:

- Normalize header values explicitly.
- Reject arrays for `Origin`.
- Add tests for duplicate/header-array cases.

### P1-3: `.diptych` control-plane changes are invisible to approval gating

Evidence:

- Approval snapshots filter out `.diptych/` in `src/engine/orchestrator/approval/file-snapshots.ts`.
- `.diptych` contains approval, hook trust, state, session, lock, and IPC files.
- `.diptych` is also gitignored.

Impact:

- A compromised or buggy implementer command/hook can alter `.diptych/approvals.json`, hook trust, state, or session artifacts without appearing in normal approval/change review.

Fix:

- Treat `.diptych` as a protected control plane.
- Detect and block runner/hook writes to sensitive `.diptych` files, or run implementers in an isolated worktree/staging directory and promote only approved project files.

### P1-4: repo-map parses too much too eagerly

Evidence:

- Planning calls `buildRepoMap` by default.
- `src/engine/codebase/repomap.ts:45` does unbounded `Promise.all(absFiles.map(...getOrParse...))`.
- Each parse reads the full file and parses it with Tree-sitter.
- Token budget is applied after parsing/ranking.

Impact:

- Large repos can spike CPU, memory, file descriptors, and startup latency before the planner starts.
- `tokenBudget` limits prompt size, not scanning/parsing cost.

Fix:

- Add parse concurrency limits.
- Skip large/generated files before parsing.
- Add max file/byte guards.
- Apply candidate filtering before full AST parsing where possible.

### P1-5: repo-map excludes do not reliably prune heavy directories

Evidence:

- Default exclude regexes are `/node_modules\//`, `/dist\//`, and `/\.diptych\//`.
- Discovery tests the current relative directory path before recursion.
- Top-level `node_modules`, `dist`, and `.diptych` do not match those regexes because they lack a trailing slash.
- `.git` is not excluded.
- User `excludePatterns` replace defaults rather than merging with them.

Impact:

- Workflow startup can walk huge directories.
- A user-provided exclude list can accidentally re-enable default heavy-directory scanning.

Fix:

- Exclude by path segment/directory name.
- Include `.git` and common caches.
- Merge user excludes with defaults unless explicitly configured otherwise.

### P1-6: streamed planner text creates unbounded event bytes and repeated full-text render work

Evidence:

- Planner text chunks are merged with `last.text + event.text` in `src/stores/workflow/events.ts:30`.
- `MAX_EVENTS` bounds event count, not bytes.
- Render height repeatedly splits the full growing string.
- `MarkdownBlock` reparses full text.

Impact:

- Long streamed responses trend toward quadratic string copying/parsing and can stall Ink.

Fix:

- Keep streamed text as bounded chunks.
- Render only the visible/tail window.
- Cap retained TUI text.
- Store full transcripts separately from render state.

### P1-7: event persistence is synchronous on the event bus path

Evidence:

- Event bus sinks are synchronous.
- JSONL persistence runs per event.
- `appendLine` calls `appendFileSync` and ensures the directory every time.
- Transcript buffering writes synchronously after chunks.

Impact:

- Model streaming, TUI updates, hooks, and persistence share one blocking path.
- Slow disks or remote filesystems can directly delay streamed output.

Fix:

- Batch JSONL and transcript writes.
- Create directories once.
- Use async writes with controlled flushing.
- Coalesce low-value stream chunks before persistence.

### P1-8: process, stdout, and IPC streaming ignore backpressure and retain full output

Evidence:

- Child stdin writes ignore `write()` backpressure.
- Several helpers concatenate all stdout/stderr into strings.
- IPC `socket.write` ignores backpressure.
- Replay loads all events into an array.
- Live replay backlog is unbounded.

Impact:

- Verbose tools, large sessions, or slow IPC clients can cause memory growth and event-loop stalls.

Fix:

- Honor `drain`.
- Stream replay instead of materializing all events.
- Cap retained stdout/stderr tails where full text is unnecessary.
- Bound or coalesce live backlog.

### P1-9: `test-ci` does not run documented invariant gates

Evidence:

- `package.json:28` runs only typecheck, Biome, and Vitest.
- `docs/INVARIANTS.md:7` says `npm run test-ci` plus extra grep gates.

Impact:

- Critical architecture invariants remain manual: barrels, classes, memoization, engine/UI boundaries, legacy event names, `.js` import suffixes, and more.

Fix:

- Add `check:invariants`.
- Include it in `test-ci`.
- Prefer a small Node invariant checker over fragile greps where import resolution matters.

### P1-10: documented invariant commands are incomplete

Evidence:

- `docs/INVARIANTS.md` checks `index.ts`, while `NO-BARRELS.md` bans both `index.ts` and `index.tsx`.
- The engine import check only covers `features`, while conventions also ban React, Ink, components, hooks, and CLI imports from engine.
- There is no explicit relative `.js` import suffix gate.

Impact:

- The documented gates can pass while the actual conventions are violated.

Fix:

- Replace fragile checks with a small import-boundary checker.
- Include `index.tsx`, engine-to-UI imports, and ESM `.js` suffix enforcement.

### P1-11: open-source package declares MIT but lacks a LICENSE file

Evidence:

- `package.json:43` declares MIT.
- README says MIT.
- `npm pack` reported no license file.
- No root `LICENSE*` exists.

Impact:

- Open-source handoff is incomplete and less professional.

Fix:

- Add root `LICENSE` with MIT text.
- Include it in the package allowlist.

### P1-12: docs/package claims drift

Evidence:

- README quick start presents generic `npm install -g diptych`.
- Windows caveat appears much later.
- Detached/server lifecycle commands are blocked on Windows.
- `docs/USAGE-EXAMPLES.md` advertises `await import('diptych/cli')`.
- `package.json` has no `exports` or `main`; only `bin` is declared.

Impact:

- Customers can follow documented paths that do not work.
- Windows users can install before discovering key commands are unsupported.

Fix:

- State supported OSes prominently or implement Windows IPC/server lifecycle support.
- Either remove the `diptych/cli` import example or add a real `exports` entry after deciding whether importing the CLI should parse argv.

### P1-13: handoff tests do not prove final handoff readiness

Evidence:

- Render tests intentionally emit `briefHash: <placeholder>`.
- Write logic replaces placeholders later.
- Write tests mostly assert files exist and manifest fields are present.

Impact:

- Tests may pass while final on-disk handoff packs contain placeholders or mismatched manifest/task hashes.

Fix:

- Add a `writeHandoffPack` readback test.
- Open `manifest.json` and `tasks/T001.md`.
- Assert no `<placeholder>`, matching `briefHash`, correct task IDs, and required handoff sections with non-empty content.

---

## P2 - Quality, Architecture, And Test Debt

### P2-1: unsafe assertion rules are disabled and some unsanctioned non-null assertions exist

Evidence:

- `biome.json:32` disables `noNonNullAssertion`.
- `biome.json:43` disables `noExplicitAny`.
- Reported production non-null assertions outside documented exception areas include `tree-recorder.ts` and `external-editor.ts`.

Fix:

- Enable the rule where practical.
- Use targeted `biome-ignore` comments only for documented exceptions.
- Remove avoidable assertions.

### P2-2: IPC server messages are cast instead of parsed

Evidence:

- `use-ipc-client.ts` and `detach.ts` cast `JSON.parse(...) as ServerMessage`.
- Client messages have a parser, but server messages do not.

Fix:

- Add `parseServerMessage(value: unknown)`.
- Use it at all socket consumers.

### P2-3: `import type` convention is disabled and drifting

Evidence:

- `docs/TYPES.md` says cross-module types should use `import type`.
- `biome.json:33` disables `useImportType`.
- A read-only rule probe found 29 warnings.

Fix:

- Enable `useImportType`.
- Apply safe fixes.

### P2-4: `npm run format` exists but Biome formatter is disabled

Evidence:

- `package.json:19` exposes `biome format --write .`.
- `biome.json:21` disables the formatter.

Fix:

- Enable Biome formatting or remove/rename the script so tooling matches reality.

### P2-5: orchestrator tests sometimes assert implementation details

Evidence:

- `docs/TESTING.md` says orchestrator control flow should be covered via `runWorkflow()`.
- Several orchestrator tests import internals and assert call counts, selected fakes, factory calls, event ordering, or prompt fragments.

Fix:

- Keep pure decision-unit tests.
- Move handoff-critical orchestration scenarios to integration tests around `runWorkflow()`.
- Assert durable outcomes: events emitted, recovery state, files written, budget/escalation behavior, and final status.

### P2-6: IPC/process tests use real sleeps and timing shortcuts

Evidence:

- `use-ipc-client` tests use repeated `tick(50/100/200)`.
- One helper manually emits `close` on a server.
- Hook sink/process tests poll wall-clock inactivity or mix child processes with timing assertions.

Fix:

- Replace arbitrary sleeps with event-driven promises or `vi.waitFor`.
- Inject reconnect backoff/clock behavior.
- Remove manual lifecycle shortcuts that hide real bugs.

### P2-7: drained queued user messages remain in workflow state forever

Evidence:

- Queue limit counts only undrained messages.
- `DRAIN_QUEUE` marks `drainedAt`.
- `CLEAR_QUEUE` keeps drained messages.
- State saves write the whole JSON.

Impact:

- Long interactive sessions grow memory and `state.json`.

Fix:

- Remove drained messages after persistence/injection, or keep only a small recent audit trail in state and move history to append-only transcript storage.

### P2-8: budget enforcement may not cover planning/final-review spend

Evidence:

- Planner usage is added after planning.
- Budget enforcement is called after tasks.
- Final review adds usage and then completes without an obvious budget check.

Impact:

- If `maxBudget` is intended to cover the whole workflow, planning or final review can push total cost over budget before enforcement.

Fix:

- Define budget semantics explicitly.
- Centralize budget checks after every usage update, or enforce after planning and final review.

### P2-9: session listing reads all summaries before slicing

Evidence:

- Session UI load calls session listing.
- `listSessions` reads/parses every `summary.json`, sorts all, then slices to limit.

Impact:

- Users with many sessions can see TUI stalls.

Fix:

- Maintain an index, use async/background loading, or select recent candidates by directory metadata before parsing summaries.

### P2-10: Git access leaks past documented `lib/git.ts` boundary

Evidence:

- `docs/LAYERS.md` says git operations route through `src/lib/git.ts`.
- `src/engine/worktree.ts` imports `GitClient` and performs raw git worktree operations.

Impact:

- Changes to git telemetry, error normalization, dry-run behavior, or safety policy need duplicate handling.

Fix:

- Add named helpers in `lib/git.ts` for worktree add/remove/status/branch deletion/rev-parse behavior.
- Narrow `engine/worktree.ts` to domain orchestration.

### P2-11: recovery/resume control flow is duplicated across TUI, RPC, and headless paths

Evidence:

- Recovery handling appears in TUI hooks, RPC run loop, and headless behavior.

Impact:

- Retry override semantics, terminal status, and final-session persistence can drift across frontends.

Fix:

- Move recovery decision/application into a shared engine/core coordinator.
- Let TUI/RPC/headless provide prompt/output adapters only.

### P2-12: worker prompt packet construction and preview can drift

Evidence:

- Runtime implementer prompt assembly, API behavior, routing estimates, assessment logic, preview rendering, and UI preview are split across several modules.

Impact:

- Runtime prompt changes can silently make preview/routing estimates inaccurate.

Fix:

- Introduce one pure packet builder returning system prompt, task prompt, estimate, backend metadata, and context mode.
- Use it from dispatch, routing, assessment, and preview.

### P2-13: runtime command context is broad

Evidence:

- Runtime command registry is a broad module.
- `RuntimeCommandContext` exposes navigation, overlays, config, snapshots, attachments, handoff, approval, export, and workflow operations.
- TUI and RPC implement parallel adapters.

Impact:

- Command changes tend to require touching a broad registry plus multiple adapters.

Fix:

- Split command modules by domain.
- Replace monolithic context with smaller capability interfaces per command group.

### P2-14: one CLI success test is duplicated

Evidence:

- `start-happy-path` already asserts success exit code plus durable artifacts.
- `exit-codes` repeats only the successful exit-code part.

Fix:

- Keep success assertion in happy-path test.
- Reserve `exit-codes.test.ts` for distinct failure classes.

---

## Checked OK

These areas were reviewed and did not produce a concrete finding in this pass:

- IPC is local Unix-socket based, not TCP.
- IPC sockets live under per-session directories created with secure permissions.
- MCP binds to `127.0.0.1`.
- MCP uses bearer auth for `/mcp`.
- MCP has a local origin check and 1 MB request body cap.
- Health endpoint is unauthenticated, but only returns `ok` on localhost.
- The shared process runner generally uses argv arrays, not `shell: true`.
- The shell fallback quotes argv components; no concrete shell injection path was found.
- API keys are read from config/env and config writes use secure file modes.
- No intentional normal-provider API-key emission was found.
- User-controlled project paths are mostly confined through shared path-confinement helpers.
- No direct task-file path traversal issue was found.
- Optional `@anthropic-ai/claude-agent-sdk` peer is lazy-loaded with a clear missing-package error.
- `dist/cli.js` has a shebang and `node dist/cli.js --version` prints `0.1.0`.
- No `postinstall`/install script was found.
- No current production runtime classes were found.
- No `src`/`testing` `index.ts(x)` barrels were found in this pass.
- No production explicit `any` pattern was found in the targeted checks.
- No memoization APIs were found in production source.
- No engine-to-UI import violation was found by the targeted scan.

---

## Recommended Fix Order

### Phase 1: release and trust boundary

1. Add package `files` allowlist and package-content CI assertion.
2. Clean `dist` before build and add `prepack`.
3. Add installed-package smoke test.
4. Add `LICENSE`.
5. Fix final hook discovery/trust enforcement across all workflow entrypoints.
6. Redact and cap validation/event sink errors.

### Phase 2: local server and control plane

1. Scope MCP tool calls to allowed session IDs.
2. Normalize/reject array `Origin` headers.
3. Protect `.diptych` control-plane files from invisible runner/hook mutation.
4. Add targeted security tests for each path.

### Phase 3: large-repo and long-session performance

1. Fix repo-map excludes and merge default excludes with user excludes.
2. Add parse concurrency and file-size guards.
3. Bound streamed planner text in TUI state.
4. Batch event persistence.
5. Honor backpressure and cap retained stdout/stderr/replay data.

### Phase 4: CI invariants and test quality

1. Add `check:invariants` and include it in `test-ci`.
2. Replace fragile grep gates with a small invariant checker where needed.
3. Add handoff readback tests.
4. Rewrite implementation-detail-heavy orchestrator tests around behavior where it matters.
5. Remove flaky sleep-based testing patterns.

### Phase 5: architecture cleanup

1. Centralize recovery/resume flow.
2. Centralize worker packet construction.
3. Narrow runtime command context.
4. Route worktree git behavior through `lib/git.ts`.

---

## Next Audit Loop

This file captures the first full audit loop. The next loop should continue with:

- Dependency and native-package supply-chain audit, especially `better-sqlite3`, `tree-sitter-wasms`, `tsx`, and optional peer behavior.
- Real package install smoke test in a temp directory after the packaging changes are designed.
- Localhost/MCP adversarial request tests: duplicate headers, malformed JSON, oversized payloads, unauthorized tools, wrong-session tools.
- Data retention review for `.diptych/sessions`, transcripts, JSONL logs, OTel, and stdout JSON.
- Large-repo performance probes with synthetic heavy directories, many source files, large generated files, and long streamed planner text.
- Documentation truth audit after deciding supported OSes, package exports, and customer install path.

---

## Second Loop Findings - 2026-05-25

These findings were produced by the second audit loop after this file existed. Future agents must treat this section as part of the exclusion baseline and must not re-report these issues unless they find a materially different variant, stronger exploit path, or a regression after fixes.

Method:

- Six read-only subagents were given this audit file as an explicit baseline.
- Each was instructed to report only new, non-duplicate customer-handoff/security/performance/installability findings.
- New findings were locally spot-verified before being added here.
- `npm audit --omit=dev --json` was run and currently reports 2 production vulnerabilities: 1 high and 1 moderate.

### P0-6: runtime lockfile has production security advisories

Evidence:

- `package.json:67` declares `simple-git`.
- `package-lock.json:3516` pins `simple-git@3.33.0`.
- `package-lock.json:4241` pins `ws@8.20.0`.
- `npm audit --omit=dev --json` reports:
  - `simple-git <3.36.0`: high, remote code execution, GHSA-hffm-xvc3-vprc.
  - `ws >=8.0.0 <8.20.1`: moderate, uninitialized memory disclosure, GHSA-58qx-3vcg-4xpx.

Impact:

- Fresh semver installs may resolve patched versions, but source handoff and CI using `npm ci` install vulnerable pinned versions.
- A customer or maintainer evaluating the repo will see production audit failure.

Fix:

- Update the lockfile to patched versions.
- Tighten direct lower bounds where useful.
- Add `npm audit --omit=dev` to release or handoff CI.

Verification:

- `npm audit --omit=dev --json` should report zero production vulnerabilities.

### P0-7: mandatory runtime dependencies execute native install scripts

Evidence:

- `package.json:58` depends on `better-sqlite3`.
- `package-lock.json:1658` marks `better-sqlite3` with `hasInstallScript: true`.
- `package.json:68` depends on `tree-sitter-typescript`.
- `package-lock.json:3767` and `package-lock.json:3786` show `tree-sitter-javascript` and `tree-sitter-typescript` also have install scripts.

Impact:

- `npm install -g diptych` runs mandatory third-party native/prebuild lifecycle scripts.
- Installation can fail under `--ignore-scripts`, restricted networks, unsupported platforms/libc, ABI gaps, or corporate policy.
- This weakens the "installable CLI like Claude Code/Codex" handoff story.

Fix:

- Make repo-map cache/parsing degrade without native modules.
- Prefer pure WASM or vendored verified grammar artifacts for tree-sitter.
- Consider optionalizing `better-sqlite3` behind a fallback cache.
- Add install smoke tests with normal install and a restricted-script scenario if the latter is expected to work.

### P0-8: direct GPL runtime dependency conflicts with MIT distribution expectations

Evidence:

- `package.json:59` declares `cfonts`.
- `package-lock.json:1726` resolves `cfonts@3.3.1`.
- `package-lock.json:1730` declares `GPL-3.0-or-later`.
- `src/features/home/screen.tsx:2` imports `cfonts` for the banner.

Impact:

- An MIT CLI with a direct GPL runtime dependency creates avoidable license/compliance friction for customer handoff.
- This is not worth it for a decorative banner dependency.

Fix:

- Remove `cfonts`.
- Use a small in-repo banner string or an MIT/ISC-compatible dependency.

### P1-14: optional Anthropic peer accepts any version

Evidence:

- `package.json:44` declares `@anthropic-ai/claude-agent-sdk` as `"*"`.
- `src/engine/agent-sdk-backend.ts:54` dynamically imports it and assumes the expected module API shape.

Impact:

- Any future incompatible major version satisfies the peer range.
- Customer installs can break at runtime in ways CI does not cover.

Fix:

- Set a tested peer range.
- Document the supported SDK range.
- Validate imported module shape before using it.

### P1-15: first-run setup can orphan the active session

Evidence:

- `docs/CONFIGURATION.md` says config is created implicitly on first `diptych start`.
- `src/cli/commands/start.ts:202` creates a session before setup in the RPC branch; the TUI setup path handles setup before workflow.
- `src/features/setup/screen.tsx:44` navigates to workflow with only `feature`, not a previously created session ID.
- `src/engine/orchestrator/run/run.ts:35` generates a session ID when `opts.sessionId` is missing.
- `src/cli/commands/status.ts:65` reads the active session pointer.

Impact:

- First-run setup can create or preserve an active session pointer that does not match the workflow session users expect.
- `status`, `resume`, or recovery after interruption can target a stale or empty workflow.

Fix:

- Defer `beginSession()` until setup completes, or carry the created `sessionId` through setup into workflow.
- Ensure `.diptych/active` always points to the same session `runWorkflow` uses.

Verification:

- Add first-run tests where no config exists and `diptych start "feature"` enters setup, completes it, and then `status` points at the actual workflow session.

### P1-16: API key docs give invalid custom-provider guidance

Evidence:

- `docs/API-KEYS.md:22` says custom providers use `<PROVIDER_NAME>_API_KEY`.
- `src/core/config/accessors/runner-credentials.ts:27` does not provide env-var lookup for unknown providers.
- `src/engine/providers/registry.ts:53` and `registry.ts:54` require custom provider `apiBase` and inline `apiKey`.
- The config snippet at `docs/API-KEYS.md:38` uses `tool: deepseek`, which is not a complete valid API runner shape.

Impact:

- Customers following the page will set env vars diptych ignores or paste config that fails validation.
- The page also implies Claude Code CLI needs `ANTHROPIC_API_KEY`, which is not true for the subscription/tool-auth path.

Fix:

- Rewrite the page to distinguish known provider env vars from custom providers.
- Show complete valid config blocks with `kind: api`, `provider`, `apiBase`, `model`, and `apiKey`.
- Clarify Claude Code CLI auth separately from Anthropic API-key auth.

### P2-15: CLI provider help omits supported API providers

Evidence:

- `src/core/schemas/enums.ts:6` includes API providers `anthropic`, `openrouter`, `deepseek`, `openai`, `groq`, and `together`.
- `src/core/schemas/enums.ts:7` includes local providers `ollama` and `lm-studio`.
- `src/cli/options.ts:9` planner help lists only a subset.
- `src/cli/options.ts:12` implementer help omits several valid API providers.
- `docs/CLI-REFERENCE.md:82` mirrors incomplete provider guidance.

Impact:

- Provider onboarding is misleading.
- Users may assume valid CLI overrides are unsupported and fall back to manual config edits.

Fix:

- Update commander help and CLI reference to list all built-in providers, or describe provider flags as accepting any known/custom API provider.
- Document when `--planner-model` or `--implementer-model` is required.

### P1-17: startup discovery bypasses cache and has uncancelled probes

Evidence:

- `src/cli/init-stores.ts:55` starts discovery during store init.
- `src/engine/detection/service.ts:40` loads cached detection, but `service.ts:52` still fetches models.dev and discovers CLI models.
- `src/engine/providers/client.ts:76` calls `fetch` without an `AbortSignal`.
- `src/utils/with-timeout.ts:9` rejects on timeout but does not abort the underlying operation.

Impact:

- `start`, `resume`, and `attach` can still block on models.dev, Kilo, aider, opencode, and provider model probes even on detection-cache hits.
- Timed-out fetches can continue in the background.

Fix:

- Cache models.dev and CLI model discovery separately.
- Refresh slow discovery in the background where possible.
- Pass real `AbortSignal` timeouts through provider/list-model APIs.

### P1-18: question stream parser keeps and rescans unbounded text

Evidence:

- `src/engine/parsers/question-parser.ts:76` appends every chunk to `buffer`.
- `question-parser.ts:78` rescans the whole buffer for questions.
- `question-parser.ts:85` only trims after a complete marker suffix.
- `src/engine/claude-invoke.ts:83` feeds ordinary streamed text into this accumulator when question callbacks are enabled.

Impact:

- Long streams without complete question markers accumulate and are rescanned every chunk.
- This trends toward quadratic work and duplicate retained text.

Fix:

- Implement a bounded streaming marker parser.
- Keep only the possible partial marker/JSON tail.
- Cap marker JSON length.

### P2-16: cost UI repeatedly clones and scans the full models.dev catalog

Evidence:

- `src/stores/discovery/model-cache.ts:40` uses `structuredClone`.
- `src/features/workflow/hooks/use-cost-stats.ts:77` reads model-cache data in workflow render state.
- `src/engine/providers/model/resolution.ts:64` retrieves and scans catalog entries.

Impact:

- Workflow renders can clone and scan the entire catalog repeatedly while tokens/events update.
- This is avoidable work in the Ink render path.

Fix:

- Clone on write.
- Expose immutable snapshots on read.
- Pre-index provider/model pricing metadata for O(1) lookup.

### P1-19: extracted-code diffs use quadratic DP up to 5000 lines

Evidence:

- `src/utils/diff.ts:1` sets `LARGE_FILE_THRESHOLD = 5000`.
- `src/utils/diff.ts:16` notes the algorithm is `O(m*n)` below that threshold.
- `src/utils/diff.ts:47` allocates an `Int32Array((m + 1) * (n + 1))`.
- `src/engine/implementers/base.ts:80` computes a diff after applying extracted code.

Impact:

- A roughly 5000-line modified file can allocate around 100 MB for the DP table and stall after extracted-code implementation.

Fix:

- Use an O(ND) diff implementation.
- Or lower the threshold sharply and produce bounded preview diffs.

### P1-20: snapshots rehash and reread the whole project serially

Evidence:

- `src/engine/snapshots/store.ts:225` collects tracked files.
- `store.ts:234` hashes each tracked path for baseline snapshots.
- `store.ts:241` separately reads the same file contents.
- `store.ts:280` hashes every tracked path again for delta snapshots.

Impact:

- Large repos or large unignored assets can stall snapshot/approval flows.

Fix:

- Use changed-file indexes where possible.
- Stream hash and copy in one pass.
- Add size/path guards.
- Use bounded concurrency.

### P2-17: repo-map SQLite cache has no stale-row pruning

Evidence:

- `src/engine/codebase/cache.ts:41` creates a `SELECT` statement by path.
- `cache.ts:44` upserts parsed file rows.
- No delete/prune path was found for files no longer present in the discovered set.

Impact:

- Renamed, deleted, or branch-only files remain in `repomap.sqlite` indefinitely until manual rebuild.
- Cache footprint grows over time.

Fix:

- After discovery, delete rows not in the current file set.
- Periodically `VACUUM` or compact on rebuild.

### P1-21: existing `.diptych` control-plane paths are not hardened

Evidence:

- `src/lib/fs.ts:38` calls `mkdirSync(..., { recursive: true, mode: 0o700 })`, but this does not verify existing directories.
- `src/core/paths-io.ts:64` uses `ensureSecureDir` for session directories.
- `src/engine/ipc/server-entry.ts:77` creates the session dir with plain `mkdirSync`.
- `src/engine/ipc/server.ts:61` places the IPC socket under the session dir.
- `src/engine/ipc/spawn-server.ts:94` opens the server log in the session dir.

Impact:

- Secure control-plane paths are secure only when newly created.
- Existing `.diptych` or session dirs are not chmod-verified, owner-verified, or symlink-rejected before detached IPC sockets/logs are placed there.
- A malicious or preexisting `.diptych` tree can weaken the local privacy boundary.

Fix:

- Add a control-plane directory hardening helper.
- `lstat` each `.diptych` path component, reject symlinks, verify owner, and chmod existing dirs to `0700` or fail closed.
- Use it before IPC listen and detached file writes.
- Use no-follow/atomic write semantics for sensitive files where available.

### P1-22: IPC/RPC malformed input can amplify logs and persist secrets

Evidence:

- `src/engine/ipc/server.ts:236` appends incoming data to a client buffer without a line-size cap.
- `server.ts:247` logs invalid message structure with the raw trimmed input.
- `server.ts:251` logs malformed JSON with the raw trimmed input.
- `src/core/state/persistence.ts:45` persists event logs.
- `src/cli/rpc/reader.ts:19` echoes malformed JSON input in its error output.

Impact:

- A local client can cause log amplification or memory pressure.
- Malformed input containing API keys or bearer tokens can be persisted to `session.jsonl` or printed back.

Fix:

- Cap IPC/RPC line length.
- Close/reject on overflow.
- Never echo raw malformed request bodies.
- Emit generic diagnostics with byte count and a short hash, or redact/truncate with `redactSecrets`.

### P1-23: task IDs can silently drop tasks or collide with handoff files

Evidence:

- `src/core/schemas/task.ts:22` brands any string as `TaskId`.
- `task.ts:27` documents `TNNN` format, but schema does not enforce it.
- `src/core/state/topo-sort.ts:22` stores tasks in a `Map` by ID, so duplicates overwrite before traversal.
- `src/engine/handoff/renderers/shared.ts:99` builds artifact paths from `task.id`.
- `src/engine/handoff/write.ts:141` only checks that the final file path stays under `outDir`.

Impact:

- Duplicate planner IDs can make tasks disappear.
- Path-like IDs can create odd or colliding files inside the handoff pack.

Fix:

- Validate `TaskIdSchema` to the documented safe format.
- Reject duplicate IDs before topo sort.
- Add parser and handoff write tests for duplicate and path-like IDs.

### P1-24: project-relative task file paths are documented but not enforced before handoff

Evidence:

- `docs/TASK-CONTRACT.md:36` documents `file` as project-relative.
- `src/core/schemas/task.ts:34` only requires `file` to be a string.
- `src/engine/spec/parser.ts:12` only requires `file` to be a non-empty string.
- `src/engine/handoff/renderers/shared.ts:40` prints that value directly into task briefs.

Impact:

- A corrupt or malicious brief can produce customer handoff instructions pointing an external agent at absolute or traversal paths.

Fix:

- Add a reusable project-relative task path validator.
- Enforce it in parser/schema/handoff read paths.
- Add tests for absolute paths, `..`, and symlink-like escape cases.

### P2-18: `block-secrets` can read outside the project

Evidence:

- `src/engine/hooks/builtins/block-secrets.ts:16` resolves `event.file` with `resolveFromProject`.
- `resolveFromProject` preserves absolute paths.
- `block-secrets.ts:19` reads the resolved file.
- `block-secrets.test.ts:27` only covers normal relative files.

Impact:

- A malformed task or hook event can make the built-in secret scanner probe files outside the project during `pre_commit`.

Fix:

- Use existing path confinement helpers before reading.
- Test absolute paths, `..`, and symlink escape cases.

### P2-19: MCP evidence tools are not tested through actual HTTP server and CLI wiring

Evidence:

- `src/cli/commands/mcp.ts:65` passes `toolHandler` to the server.
- `src/engine/mcp/server.ts:168` forwards tool calls through the handler.
- Server tests start without a real tool handler.
- CLI tests mock `startMcpServer` without asserting full args.
- `tools/list` and `tools/call` are tested mainly at the JSON-RPC handler layer with a stub.

Impact:

- `diptych mcp serve` could announce tools while failing to expose real evidence writes over `/mcp`.

Fix:

- Assert the CLI start config includes a tool handler.
- Add one HTTP integration test that calls `tools/list` and `mark_task_done` against a seeded evidence ledger.

### P0-9: `@file` text attachments are persisted as the session feature

Evidence:

- `src/cli/parse-at-files.ts:103` reads text file contents.
- `src/cli/commands/start.ts:127` starts with the original feature and then builds an enriched feature from parsed `@file` context.
- `src/core/state/machine.ts:93` stores the feature in workflow state.
- `src/engine/orchestrator/summary.ts:182` includes feature in summaries.
- `src/engine/export/html-renderer.ts:139` includes feature in HTML export title.
- `src/engine/events/sinks/otel.ts:28` sends the feature as an OTel attribute.

Impact:

- Prompt-only attached text can land in `.diptych` state, JSONL, summaries, detached args/lockfiles, CLI output, HTML exports, and OTel.
- Users may expect `@file` text to be prompt context, not durable metadata.

Fix:

- Keep original display feature separate from planner attachment context.
- Do not persist full attachment text unless transcript retention explicitly allows it.
- Redact/truncate feature fields exported to summaries, CLI listing, HTML, and OTel.

### P1-25: `workflow.persistTranscript: false` still persists many text-bearing events

Evidence:

- `src/engine/events/sinks/jsonl.ts:4` treats only `planner_text` as transcript.
- `jsonl.ts:12` drops only `planner_text` when persistence is disabled.
- `src/engine/events/sinks/jsonl.test.ts:47` asserts `user_message` still persists when `persistTranscript` is false.
- `src/engine/events/types.ts:13` includes text-bearing workflow events such as feature, comments, clarification, approval, and diff-related content.

Impact:

- Users disabling transcript persistence still retain prompts, comments, clarifications, approval text, diffs, and related content in session logs and headless output.

Fix:

- Define a content-bearing event policy.
- Redact/drop content-bearing fields when transcript persistence is disabled, or rename the setting to make clear that it only suppresses planner text chunks.

### P1-26: `state.json` persists full `currentCode` source snapshots

Evidence:

- `src/engine/orchestrator/state-ops.ts:26` reads full target file content.
- `state-ops.ts:30` returns task objects with `currentCode`.
- `src/core/state/machine.ts:241` persists `currentCode` through `UPDATE_TASK_CODE`.
- `src/core/state/persistence.ts:15` writes the full workflow state.
- `src/engine/orchestrator/task/commit.ts:85` advances task state after validation without clearing `currentCode`.

Impact:

- Source files used as transient prompt context are duplicated into durable session state and can remain after task completion.

Fix:

- Keep current code ephemeral.
- Persist only hashes or snippets when needed for resume.
- Clear `currentCode` after prompt construction or task completion.

### P1-27: CLI handoff defaults outside `.diptych`

Evidence:

- `src/cli/commands/handoff.ts:73` defaults output to `handoff/<target>` under the project root.
- `docs/CLI-REFERENCE.md:833` documents `./handoff/<target>/` as the default.
- `src/engine/handoff/write.ts:114` writes specs, plans, and task briefs into that directory.

Impact:

- Sensitive handoff packs can be created outside the `.diptych` retention/ignore boundary.
- Users may accidentally commit or sync them.

Fix:

- Default handoff output to `.diptych/sessions/<id>/handoffs/<target>/`, or auto-ignore/warn when writing outside `.diptych`.

### P1-28: global input history stores recent prompts outside project retention

Evidence:

- `src/stores/ui/input-history.ts:7` keeps recent entries.
- `src/stores/ui/persistence.ts:10` writes global history to `~/.diptych/history`.
- `src/components/composer/composer.tsx:129` pushes home-screen submissions into global history.
- `docs/GETTING-STARTED.md:257` says everything lives under project `.diptych/`.

Impact:

- Prompts, slash-command args, paths, or copied secrets can persist globally across projects.
- This is not governed by session cleanup or `persistTranscript`.
- Docs currently imply a narrower retention boundary than the app actually uses.

Fix:

- Add an opt-out and clear-history command.
- Consider project-scoped history.
- Redact command args and secret-like values before writing history.
- Update docs to mention global UI history if it remains.

### P2-20: session tree files do not enforce secure file modes

Evidence:

- `src/core/sessions/tree/io.ts:18` uses plain `appendFileSync`.
- `tree/io.ts:24` writes metadata via plain temp file and rename.
- Secure helpers exist in `src/lib/fs.ts`, and other state persistence uses secure modes.

Impact:

- If an existing session directory has broad permissions, tree metadata can inherit process umask and expose feature/task/file-path details.

Fix:

- Use `ensureSecureDir`, `SECURE_FILE_MODE`, and chmod repair for tree files.

---

## Updated Next Audit Loop

The next audit loop must use both the original findings and the second-loop findings above as the exclusion baseline. It should not re-report any finding in this file.

The next lanes should focus on:

- Real exploitability and reproduction tests for P0/P1 security findings.
- Dependency license and install-script replacement options.
- Provider onboarding end-to-end tests.
- `.diptych` retention and cleanup policy design.
- Post-fix verification plan for packaging, native install behavior, MCP HTTP tools, and transcript/privacy modes.

---

## Third Loop Findings - 2026-05-25

These findings were produced by a third audit loop after the original and second-loop findings were already written. Future agents must treat this section as part of the exclusion baseline too.

Method:

- Four read-only subagents were given the full audit file as an exclusion baseline.
- New findings were checked locally before inclusion.
- Findings already captured elsewhere in this file were intentionally not repeated.

### P0-10: custom handoff renderers execute repo-local code without a trust gate

Evidence:

- `src/engine/handoff/render.ts:62` resolves `.diptych/handoff-renderers/<target>.ts`.
- `src/engine/handoff/render.ts:63` resolves `.diptych/handoff-renderers/<target>.js`.
- `src/engine/handoff/load-renderer.ts:21` dynamically imports the resolved renderer.
- A subagent PoC confirmed top-level renderer code executed on import.

Impact:

- Running `diptych handoff <target>` in an untrusted repo can execute attacker-controlled JS with the user's environment and filesystem access.
- This is a separate extension point from hooks, so the existing hook trust model does not cover it.

Fix:

- Add a fail-closed trust check for custom handoff renderers.
- Require explicit hash approval or a dedicated `--allow-custom-renderer` flag.
- Reject in non-interactive mode unless pre-trusted.

Verification:

- Add tests proving untrusted custom renderers do not import or execute.
- Add tests for trusted renderer execution.

### P0-11: secure file writes follow symlinks and can overwrite outside-repo files

Evidence:

- `src/lib/fs.ts:42` defines `writeSecureFile`.
- `src/lib/fs.ts:44` calls `writeFileSync(filePath, ...)` directly.
- `src/lib/fs.ts:45` calls `chmodSync(filePath, ...)` directly.
- Callers include:
  - config writes in `src/core/config/load/load.ts:155`,
  - approvals in `src/core/approval/store.ts:30`,
  - hook trust in `src/core/hooks/trust.ts:40`,
  - active session writes in `src/core/sessions/lifecycle.ts:16`.
- A subagent PoC with `.diptych/config.yaml -> /tmp/outside` confirmed the outside target was overwritten.

Impact:

- A malicious repo can pre-place symlinks under `.diptych`.
- Normal config/trust/session writes can clobber user-owned files outside the project and chmod them `0600`.

Fix:

- Reject symlink targets with `lstat`.
- Verify parent realpaths remain confined under the hardened `.diptych` control-plane root.
- Write via a temp file in a verified real directory, then rename.
- Use no-follow/open-safe semantics where available.

Verification:

- Add symlink attack tests for config, approvals, hook trust, active session, and any other secure-file caller.

### P0-12: snapshot manifests and symlinks allow outside-project read/write paths

Evidence:

- `src/core/schemas/snapshot.ts:12` accepts raw string paths in snapshot file entries.
- `src/engine/snapshots/restore.ts:97` iterates manifest paths.
- `src/engine/snapshots/restore.ts:98` joins manifest path directly to `projectDir`.
- `src/engine/snapshots/restore.ts:141` reads snapshot blob contents.
- `src/engine/snapshots/restore.ts:143` writes to the joined path.
- `src/engine/snapshots/run.ts:189` joins `opts.path` to `projectDir` for rejection restore.
- `src/engine/snapshots/store.ts:234` hashes tracked paths.
- `src/engine/snapshots/store.ts:241` reads tracked file contents.
- A subagent PoC confirmed `../outside.txt` restore wrote outside the repo and a repo symlink caused outside content to be captured.

Impact:

- A tampered `.diptych` snapshot can make restore/reject-run write arbitrary user-owned files outside the repo.
- A repo symlink can cause snapshots to retain outside secret contents under `.diptych/sessions/.../snapshots`.

Fix:

- Validate every manifest path with confinement checks before read/write.
- Reject `..` and absolute paths.
- Validate encoded blob names.
- Use `lstat` during capture.
- Store symlinks as symlinks or skip them.
- Use `assertWritablePathConfined` before restore writes.

Verification:

- Add tests for tampered snapshot manifests, traversal paths, absolute paths, symlinked project files, and encoded blob names.

### P0-13: `handoff --mode overwrite --out` can delete arbitrary directories

Evidence:

- `src/cli/commands/handoff.ts:73` passes `opts.out` through as the output directory.
- `src/engine/handoff/write.ts:130` checks `mode === 'overwrite'`.
- `src/engine/handoff/write.ts:133` recursively removes `outDir` before writing the pack.

Impact:

- A mistaken command such as `diptych handoff claude --mode overwrite --out src` can delete project source files.
- A broader path can delete arbitrary user-writable directories.

Fix:

- Add output-root confinement.
- Refuse dangerous paths such as project root, `.git`, `src`, `dist`, parent directories, and any path outside an explicit handoff root.
- Prefer a safe default under `.diptych` as already noted in P1-27.

Verification:

- Add destructive-path tests for project root, `src`, `.git`, parent paths, and outside-project paths.

### P1-29: readiness misses configured typecheck/lint command failures

Evidence:

- `src/core/readiness/checks/validation.ts:17` builds readiness validation checks.
- Current readiness posture primarily checks `testCommand` and missing npm test scripts.
- Runtime validation runs `typecheckCommand`, `lintCommand`, and `testCommand` separately in `src/engine/orchestrator/validation.ts:95`, `validation.ts:106`, and `validation.ts:117`.
- `docs/CONFIGURATION.md:323` documents validation command overrides.

Impact:

- A project can pass `diptych doctor` or start readiness with enabled typecheck/lint commands that are absent or invalid.
- The workflow can later fail or silently skip configured validation.

Fix:

- Make readiness validate all enabled configured validation commands, not only tests.
- Distinguish missing command, missing script, skipped command, and passed command.

### P1-30: readiness can report ready before proving `.diptych` is writable

Evidence:

- `src/core/readiness/collect.ts:33` collects readiness from config, package scripts, repo posture, and active session state.
- `src/cli/commands/start.ts:185` collects readiness in `start --json`.
- `src/cli/commands/start.ts:186` emits the readiness report before session writes.
- Session writes happen later through session lifecycle and readiness persistence.

Impact:

- A read-only or wrong-owner `.diptych` tree can produce a machine-readable "ready" report and then fail before the session exists.

Fix:

- Add a `.diptych` writable/control-plane hardening check to readiness.
- In JSON mode, do not emit a ready report before all required control-plane writes can succeed.

### P1-31: dedicated e2e suite is not a release gate and bypasses customer CLI entrypoints

Evidence:

- `package.json:23` defines `test:e2e`.
- `package.json:28` defines `test-ci` without `test:e2e`.
- `vitest.config.ts:5` includes source tests, integration tests, helpers, and one eval test, but not `testing/e2e`.
- The e2e harness calls `runWorkflow()` directly rather than invoking `diptych start`.

Impact:

- Release gates skip the e2e suite.
- Even when run, e2e tests bypass CLI readiness, setup, session creation, package/bin behavior, and command parsing.

Fix:

- Decide which e2e tests are release gates.
- Add at least one true CLI-entrypoint e2e test for the customer path.
- Keep lower-level `runWorkflow()` harness tests, but do not treat them as proof of CLI handoff readiness.

### P2-21: `diptych init` docs claim detected-model config but tests prove only default config

Evidence:

- `src/cli/commands/init.ts:15` describes init as creating config with detected models.
- `docs/CLI-REFERENCE.md:285` says config is populated with detected planner/implementer providers and models.
- `testing/integration/cli/init-config-roundtrip.test.ts:27` tests that init writes the default config shape.
- `src/features/setup/screen.test.tsx:16` covers a no-planner setup message, not detected model persistence.

Impact:

- Docs and command description promise stronger first-run behavior than tests prove.
- Users may expect `init` to persist detected provider choices when it actually writes defaults and opens setup.

Fix:

- Either update docs to match default-config behavior or implement/test detected model persistence.
- Add setup flow tests for selected runner persistence.

### P2-22: `doctor` cannot preflight actual workflow invocation with CLI overrides

Evidence:

- `src/cli/commands/doctor.ts:7` accepts only `--project` and `--json`.
- `doctor` calls `collectReadiness({ projectDir })` without workflow opts.
- `src/cli/commands/start.ts:185` does pass workflow options into readiness.
- `src/core/readiness/collect.ts:83` can apply CLI overrides.

Impact:

- `diptych doctor` is a weaker CI preflight than the actual `diptych start --planner/--implementer/--mode/--budget ...` command.
- Users relying on CLI overrides cannot preflight the real invocation.

Fix:

- Add the same workflow override flags to `doctor`, or add `diptych doctor --start-args ...`.
- Document which readiness path is authoritative.

### P1-32: `engines.node` overclaims future Node majors

Evidence:

- `package.json:7` declares `node >=22`.
- `package-lock.json:1658` locks `better-sqlite3@12.9.0`.
- `package-lock.json:1668` and `package-lock.json:1669` show `better-sqlite3` supports `20.x || 22.x || 23.x || 24.x || 25.x`.

Impact:

- Node 26+ satisfies diptych's root engine but not a mandatory native dependency.
- Installs can warn, fail under `engine-strict`, or hit unsupported native builds.

Fix:

- Narrow the root engine, for example `>=22 <26`, or optionalize/upgrade the dependency before claiming newer majors.

### P1-33: basic CLI startup eagerly loads native SQLite

Evidence:

- `src/cli.ts:6` imports `registerStartCommand`.
- `src/cli/commands/start.ts:15` imports `runHeadless`.
- `src/cli/headless.ts:10` imports `runWorkflow`.
- `src/engine/orchestrator/planning/run.ts:1` imports `buildRepoMap`.
- `src/engine/codebase/repomap.ts:5` imports `createParseCache`.
- `src/engine/codebase/cache.ts:1` imports `better-sqlite3`.

Impact:

- Even basic CLI paths such as help/version can require the native SQLite dependency to install and load.
- This increases install fragility and makes failures surface before users reach a workflow that actually needs repo-map caching.

Fix:

- Lazy-load workflow/planning/repo-map modules after command dispatch.
- Lazy-load SQLite only inside the repo-map cache path.
- Add a smoke test that `diptych --help` works when optional/native repo-map cache is unavailable if cache is made optional.

### P1-34: enabled validation can complete a task with no effective validation

Evidence:

- `src/engine/orchestrator/validation.ts:107` skips lint when no command resolves.
- `validation.ts:123` skips default tests when no matching test file exists.
- `validation.ts:178` treats command-not-found (`127`) as passed.
- `src/engine/orchestrator/task/commit.ts:38` accepts all-passed results, including an empty/all-skipped set.

Impact:

- Validation can be enabled, but no meaningful validation may run before task completion.
- Customer confidence in "validated" tasks can be false.

Fix:

- Track `skipped` distinctly from `passed`.
- Fail or warn loudly when configured stages did not actually run.
- Require explicit opt-out for missing validation commands.

### P2-23: handoff validation metadata can lie to downstream agents

Evidence:

- `src/engine/handoff/write.ts:45` resolves handoff validation metadata.
- It hardcodes `npm run typecheck` and `npm run lint`.
- `src/engine/handoff/write.ts:174` publishes validation metadata in the manifest.

Impact:

- Handoff packs can tell downstream agents to run commands that do not match the session's configured validation commands or non-Node project heuristics.

Fix:

- Reuse the runtime validation resolver.
- Persist the session's resolved validation commands and write those into handoff metadata.

### P2-24: existing malformed config silently falls back to defaults

Evidence:

- `src/core/config/load/load.ts:126` returns `createDefaultConfig()` for empty, primitive, or array YAML.
- Tests lock this behavior in.
- Readiness then reports config as loaded.

Impact:

- A malformed existing config can be treated as a valid default config.
- Users may not notice that their intended config was ignored.

Fix:

- Treat an existing non-object or empty config as invalid.
- Reserve defaults for a missing config only.

---

## Final Baseline For Next Loop

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.

Any further audit agent must first read this whole file and exclude every finding listed here. New reports should be accepted only if they identify a real, non-duplicate issue with concrete evidence.

---

## Fourth Loop Findings - 2026-05-25

These findings were produced by a fourth audit loop after the original, second-loop, and third-loop findings were already written. Future agents must treat this section as part of the exclusion baseline too.

Method:

- Six read-only subagents were given the full audit file as an exclusion baseline.
- Reports were restricted to new, non-duplicate P0/P1 issues or an explicit no-new-finding result.
- New findings were locally checked before inclusion.
- A local license/install-script sweep found no additional license blocker beyond already-listed `cfonts`; runtime native install scripts remain covered by earlier findings.

### P1-35: configured repo-map cache path is not confined before write/delete

Evidence:

- `src/core/schemas/codebase.ts:6` accepts `cacheDir` as a string.
- `src/engine/codebase/cache-path.ts:7` resolves the cache dir.
- `cache-path.ts:9` uses `resolveFromProject`, which preserves absolute paths and allows `..` to escape the project.
- `src/engine/codebase/repomap.ts:33` creates the resolved cache dir during planning.
- `src/engine/codebase/rebuild.ts:14` resolves the repo-map DB path.
- `rebuild.ts:15` builds candidates for `repomap.sqlite`, `repomap.sqlite-shm`, and `repomap.sqlite-wal`.
- `rebuild.ts:18` can delete those paths.

Impact:

- A malicious or mistaken config can make startup create/write repo-map cache files outside the project.
- `/repomap rebuild` can unlink same-named SQLite files outside the project.

Fix:

- Constrain `codebase.cacheDir` to a project-relative safe path.
- Reject absolute paths, `..`, symlinked cache parents, and paths outside `.diptych` unless there is a deliberately trusted override.
- Add tests for absolute paths, traversal paths, and symlinked cache parents.

### P0-14: planner-discovered validation commands are executed as trusted subprocesses

Evidence:

- `src/engine/spec/prompts/research.ts:53` asks the planner to identify validation tools.
- `src/engine/orchestrator/planning/parse-validation.ts:3` parses planner-produced validation markdown.
- `parse-validation.ts:18`, `:19`, and `:20` store planner-produced typecheck/lint/test command strings.
- `src/engine/orchestrator/planning/full.ts:73` reads the research phase.
- `full.ts:75` parses discovered validation.
- `src/engine/orchestrator/validation.ts:51` selects validation commands from config, discovered validation, heuristics, or fallback.
- Runtime validation later executes resolved commands in the project cwd.

Impact:

- A malicious repo prompt-injection or compromised planner can turn a research answer like `Type checker: ./scripts/evil` into local process execution during normal validation.
- This is a distinct execution surface from hook trust, custom runner config, and custom handoff renderers.

Fix:

- Do not execute planner-discovered command strings directly.
- Treat planner-discovered validation as suggestions requiring user/config approval.
- Resolve only allowlisted package scripts or known safe tool patterns.
- Add a trust/approval boundary before executing model-discovered commands.

Verification:

- Add tests proving planner-discovered `./local-script` and shell-like commands are not executed without explicit approval.

### P0-15: planner-controlled `task.file` can read outside-project files into state and prompts

Evidence:

- `src/engine/spec/parser.ts:12` accepts task `file` as a non-empty string.
- `parser.ts:73` reads that field directly from task frontmatter.
- `src/engine/orchestrator/state-ops.ts:26` joins `projectDir` with `task.file` and reads current code.
- `src/core/state/machine.ts:241` can persist `currentCode` into workflow state.
- `src/engine/spec/prompt-formatter.ts:127` inserts current code into implementer prompts.
- `src/features/workflow/components/brief-review.ts:205` refreshes task code for routing preview.
- `src/engine/implementers/base.ts:133` and `:135` read file snapshots using `join(projectDir, task.file)`.

Impact:

- A planner-produced task with `file: ../sensitive-file` can read outside the project.
- The contents can be persisted in `.diptych` state and sent to implementers/providers as "Current Code".

Fix:

- Enforce a project-relative task path validator before any read/write/prompt/handoff path.
- Reject absolute paths, traversal paths, and symlink escapes.
- Add tests for parser, state refresh, brief review preview, implementer snapshots, and handoff rendering.

### P1-36: project-local custom runner commands bypass the trust boundary

Evidence:

- Project `.diptych/config.yaml` is loaded automatically.
- `src/core/schemas/runner-fields.ts:28` allows shell runner fields.
- `runner-fields.ts:30` accepts arbitrary command strings.
- `runner-fields.ts:31` accepts arbitrary args.
- Startup trust-checks hooks, but not custom runner commands.
- Availability probing can execute configured commands with `--version` through `src/lib/availability.ts:13`.
- Planner and implementer command runners later execute configured commands.

Impact:

- A cloned repo can include `.diptych/config.yaml` pointing planner or implementer commands at repo-local executables.
- Running diptych can execute them without the trust prompt used for hooks.

Fix:

- Treat project-local custom runner commands as an executable extension surface.
- Require trust approval for shell/agent/custom runner commands loaded from project config.
- In non-interactive mode, fail closed unless explicitly allowed.

### P1-37: planner heartbeat cleanup is not in `finally`

Evidence:

- `src/engine/orchestrator/planning/shared.ts:91` starts planner heartbeat.
- `shared.ts:93` subscribes heartbeat token updates.
- `shared.ts:101` awaits `withContinuationLoop`.
- `shared.ts:158` stops heartbeat only after successful loop return.
- `src/engine/orchestrator/planning/heartbeat.ts:36` starts a timeout.
- `heartbeat.ts:38` starts an interval after the threshold.

Impact:

- Planner failures can leave a live timer/subscription.
- CLI or detached server processes can stay alive and keep publishing stale heartbeat events.

Fix:

- Wrap planning loop cleanup in `try/finally`.
- Stop heartbeat and unsubscribe in `finally` for every planning exit path.

### P1-38: planner abort signals are created but not propagated to planner backends

Evidence:

- `src/engine/orchestrator/continuation.ts:63` creates an `AbortController`.
- `continuation.ts:64` sets abort handler.
- `src/engine/orchestrator/planning/shared.ts:101` passes `signal` into continuation context.
- Planning body ignores that signal when invoking planner backends.
- `PlannerCallbacks` has no `signal` field.
- Lower-level API/process stream helpers already support abort signals, but planner implementations do not pass one through.

Impact:

- Ctrl+C or RPC abort can leave API streams or planner subprocesses running.
- This can waste tokens, keep processes alive, and create confusing late output.

Fix:

- Add `AbortSignal` to planner invoke/review/escalation paths.
- Wire it through every planner backend and process/API streaming call.
- Add abort tests for API planners and command-based planners.

### P1-39: composer `@file` completion synchronously indexes the whole project

Evidence:

- `src/components/composer/composer.tsx:168` refreshes project files on mount/project change.
- `src/lib/file-listing.ts:24` uses blocking `execFileSync('git', ...)`.
- `file-listing.ts:40` uses recursive `readdirSync` fallback.
- `src/components/composer/completion/reference/hook.ts:60` rebuilds `new Fzf(files)` during filtering.

Impact:

- Large repos or non-git trees can stall startup and typing in the TUI.

Fix:

- Lazy/background index project files.
- Add caps and broader skip directories.
- Reuse a search index instead of rebuilding it during render/filtering.

### P1-40: final review sends an unbounded full-repo diff to the planner

Evidence:

- `src/lib/git.ts:72` reads current diff.
- `git.ts:74` and `:75` read staged and unstaged diffs concurrently.
- `src/engine/orchestrator/final-review.ts:83` embeds the diff into the final review prompt.
- `src/engine/spec/prompts/review.ts:33` includes the full diff in a fenced code block.

Impact:

- Large/generated changes can spike memory, exceed model context, or cause expensive final-review calls to fail late.

Fix:

- Cap/chunk/summarize diffs before prompt construction.
- Apply generated/large-file guards.
- Report omitted files explicitly so review remains honest.

### P1-41: default production install pulls the full `tree-sitter-wasms` grammar bundle

Evidence:

- `package.json:74` declares `tree-sitter-wasms` under `optionalDependencies`.
- npm installs optional dependencies by default.
- `src/engine/codebase/languages.ts:44` starts non-TS language configs.
- `languages.ts:47` uses `tree-sitter-wasms` for Python grammar loading.
- Local `du -sh node_modules/tree-sitter-wasms` measured about 49 MB.
- A subagent temp production install from the packed tarball produced about 238 MB of `node_modules`, with `tree-sitter-wasms` around 50 MB.

Impact:

- Default customer installs download and audit a large set of unused binary grammar artifacts.
- This increases install size and supply-chain surface.

Fix:

- Vendor or depend on only the needed WASM grammars.
- Split non-TypeScript language support into smaller optional packages.
- Lazy-install/load non-TS grammars with clear docs and provenance.

### P1-42: first-run `--json` and `--rpc` corrupt structured stdout

Evidence:

- `src/cli/setup.ts:33` checks for missing config.
- `setup.ts:34` prints `NO_CONFIG_MSG` with `console.log`.
- `src/cli/commands/start.ts:182` enters the `--json` path.
- `start.ts:184` calls `ensureGitAndConfig`.
- `start.ts:186` writes the structured readiness line.
- `start.ts:195` enters the `--rpc` path.
- `start.ts:197` also calls `ensureGitAndConfig`.
- `docs/CLI-REFERENCE.md:159` documents the first structured readiness line.

Impact:

- On first run with no config, stdout contains human text before the JSON/RPC readiness record.
- Automation that expects machine-readable first-line output breaks.

Fix:

- Send setup/init notices to stderr in structured modes, or suppress them.
- Add first-run `--json` and `--rpc` tests with no config.

### P1-43: first-run setup drops `@file` text context

Evidence:

- `src/cli/commands/start.ts:127` starts with original feature.
- `start.ts:131` parses `@file` inputs.
- `start.ts:132` creates an enriched feature.
- `start.ts:227` initializes setup router with original `feature`.
- `src/features/setup/screen.tsx:44` navigates to workflow with `pendingFeature` only.
- Normal non-setup workflow path uses `plannerFeature ?? feature`.

Impact:

- A fresh `diptych start "build it" @brief.md` can silently lose file context after the setup wizard.

Fix:

- Carry the enriched planner feature and attachments through setup.
- Add a first-run setup test with `@file` input.

### P1-44: `/handoff` is advertised on summary but fails after normal completion

Evidence:

- `/handoff` is registered as a runtime command available on workflow/summary screens.
- `src/features/workflow/screen.tsx:100` navigates to summary with a `sessionId`.
- `src/engine/orchestrator/session-lifecycle.ts:54` clears active session on normal completion.
- `src/app/command-context.ts:86` implements `writeHandoff` by reading the active session.
- `src/app/command-context.ts:141` shows `exportSession` already uses `currentSessionId`.

Impact:

- `/handoff` can fail exactly on the post-completion summary screen where users are likely to run it.

Fix:

- Use the route/current session ID for handoff, matching export behavior.
- Add summary-screen handoff tests after workflow completion.

### P1-45: `tasks.md` persists copied source/current-code context outside state

Evidence:

- `src/engine/spec/prompts/tasks.ts:11` asks for `### Current Code` copied from the project when relevant.
- `src/engine/spec/parser.ts:93` accepts `sections.currentCode` into `task.currentCode`.
- `src/engine/spec/formatter.ts:73` writes `### Current Code`.
- `formatter.ts:76` writes the current code contents.
- `src/engine/orchestrator/planning/shared.ts:50` persists planning phase artifacts to session files.

Impact:

- Clearing `state.json` current code is not enough; copied code can remain in durable task brief artifacts.

Fix:

- Treat `Current Code` as content-bearing transcript data.
- Gate persistence behind transcript retention settings, truncate it, or store hashes/snippets instead.
- Add privacy tests for task markdown artifacts.

### P1-46: direct-write staging copies nearly the whole project into OS temp outside retention controls

Evidence:

- `src/engine/orchestrator/approval/staged-project.ts:23` creates a temp root under OS temp.
- `staged-project.ts:25` recursively copies the project.
- `staged-project.ts:28` defines the copy filter.
- `staged-project.ts:30` excludes only `node_modules`, `.diptych`, and `.trees`.
- Cleanup exists, but the temp root is not persisted for stale cleanup after crash/SIGKILL/reboot.

Impact:

- `.git`, `.env*`, ignored files, local docs, and other secrets can be copied outside `.diptych`.
- Crashes or host restarts can leave a full project copy in OS temp outside session retention controls.

Fix:

- Copy only required tracked files, or use a git worktree/staging area.
- Exclude `.git`, `.env*`, ignored files, and common secret/cache paths.
- Register temp roots for stale cleanup on next startup.

### P1-47: CLI backends pass full prompts through process argv

Evidence:

- `src/engine/spec/prompt-formatter.ts:127` can include current code in implementer prompts.
- `src/engine/implementers/cli.ts:32` passes full prompt to tool argument builders.
- `src/engine/cli-tools.ts:47` uses `prompt` in Codex argv.
- `cli-tools.ts:51` uses `prompt` in another CLI argv path.
- `src/engine/claude-invoke.ts:117` builds Claude args.
- `claude-invoke.ts:122` puts the effective prompt into argv unless `useStdin` is enabled.

Impact:

- Local process tables, shell history wrappers, endpoint management tools, or debugging utilities can capture feature/spec/task/current-code prompts.
- This is separate from stdout/log retention findings.

Fix:

- Prefer stdin or temp files with secure permissions for all large/sensitive prompts.
- Make argv prompts opt-in only for tools that require them, with docs explaining exposure.
- Add tests ensuring supported backends use stdin where possible.

---

## Updated Final Baseline For Next Loop

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.
- Fourth-loop findings.

Any further audit agent must first read this whole file and exclude every finding listed here. Because the fourth loop still found multiple new P0/P1 issues, the audit should continue, but future loops should be even stricter: new P0/P1 only, or explicit no-new-P0/P1 confirmation by lane.

---

## Fifth Loop Findings - 2026-05-25

Scope:

- Agents received this file as the exclusion baseline and were instructed to report only new, non-duplicate P0/P1 findings.
- Fifth-loop lanes covered security, installability/release, privacy/data retention, performance/resource lifecycle, workflow/MCP handoff, and behavior-test coverage.
- Local verification was run against the cited files before adding the findings below.

Result:

- Security found one new P0.
- Installability/release found one new P1.
- Privacy/data retention found one new P1.
- Workflow/MCP handoff found three new P1s.
- Test-behavior coverage found one new P1.
- Performance/resource lifecycle found five new P1s.

### P0-16: project config can exfiltrate provider API keys via `apiBase` override

Evidence:

- `src/core/schemas/runner-fields.ts:21` accepts arbitrary `apiBase` for API runners.
- `src/core/config/load/load.ts:107` loads project config from `.diptych/config.yaml`.
- `src/cli/init-stores.ts:47` loads the project config during TUI startup.
- `src/cli/init-stores.ts:61` runs provider capability detection after config load.
- `src/engine/providers/registry.ts:61` passes configured provider overrides into provider construction.
- `src/engine/providers/client.ts:122` prefers `overrides.apiBase` over the default provider base URL.
- `src/engine/providers/client.ts:124` falls back to the user's environment API key when no config key is provided.
- `src/engine/providers/client.ts:75` sends `Authorization: Bearer <key>` when an API key is present.

Impact:

- A malicious repo can include `.diptych/config.yaml` with a known provider such as OpenAI and an attacker-controlled `apiBase`.
- If the user has `OPENAI_API_KEY` set, starting diptych can send the key to the attacker-controlled `/models` endpoint during provider detection.
- Planner or implementer calls can also send prompts and keys to that endpoint.

Fix:

- For known providers, ignore or reject project-configured `apiBase` unless the user explicitly trusts it.
- Add a dedicated trust/allow flag for custom endpoints.
- Never combine env-sourced credentials for known providers with an untrusted non-default base URL.
- Add tests for known provider plus overridden `apiBase` plus env key.

Why not duplicate:

- This is not the custom runner command trust issue, planner-discovered validation execution, or event/OTel leakage.
- The new surface is credential exfiltration through known-provider `apiBase` override while reusing the user's environment API key.

### P1-48: sticky approval management lacks user-facing behavior tests

Evidence:

- `src/cli/commands/approval.ts:11` implements `diptych approval list/clear`.
- `src/core/runtime/commands/registry.ts:369` implements `/approval list|clear`.
- `testing/helpers/commander.ts:23` registers many CLI commands but omits `registerApprovalCommand`.
- `src/core/approval/store.test.ts:72` covers store primitive behavior, not the CLI/runtime surfaces.
- `src/core/runtime/commands/registry.test.ts:608` covers `/yolo`, but no `/approval` behavior.
- A targeted search found no behavior tests for `registerApprovalCommand`, `approval clear`, or `/approval clear`.

Impact:

- Sticky approvals are the user's revocation and inspection mechanism for prior trust decisions.
- A regression in command parsing, `--project`, scope handling, runtime/RPC slash dispatch, or corrupt-store handling could leave dangerous grants invisible or unremovable while approval-gate tests still pass.

Fix:

- Add behavior tests that seed `.diptych/approvals.json`, run `approval list`, `approval clear --scope session|always|all`, invalid scope, and `--project`.
- Assert stdout, exit code, and final file contents.
- Add `/approval list`, `/approval clear`, and invalid subcommand tests through `executeRuntimeCommand` with observable feedback and store state.

Why not duplicate:

- This is not package smoke coverage, sink redaction, MCP wiring, e2e gates, invariant gates, or approval-gate logic.
- It targets the untested customer-facing security control for managing persistent approval grants.

### P1-49: documented npm install path currently cannot work because `diptych` is not published on npm

Evidence:

- `README.md:64` documents `npm install -g diptych`.
- `package.json:2` uses the public package name `diptych`.
- `npm view diptych name version --json` returned `E404 Not Found - GET https://registry.npmjs.org/diptych - Not found` on 2026-05-25.

Impact:

- The first documented customer install command fails before package contents, native scripts, OS support, or CLI runtime behavior are reached.

Fix:

- Publish the package under the documented name, or change the README and install docs to the real install source.
- Add release verification that checks the documented install command against the target registry before shipping.

Why not duplicate:

- Earlier install findings covered tarball contents, smoke tests, package drift, advisories, license, scripts, and dependency footprint.
- This is specific to public registry availability for the documented `npm install -g diptych` path.

### P1-50: evidence/review-packet artifacts persist raw validation failure text

Evidence:

- `src/engine/orchestrator/validation.ts:176` captures raw `stdout` and `stderr`.
- `src/engine/orchestrator/validation.ts:184` stores failed `stderr || stdout` as `ValidationResult.error`.
- `src/engine/orchestrator/evidence/task-evidence.ts:26` copies the first five lines into `errorSummary`.
- `src/engine/orchestrator/evidence/persistence.ts:67` writes the ledger to `.diptych/sessions/<id>/evidence.json`.
- `src/engine/orchestrator/evidence/review-packet/sections.ts:112` preserves `errorSummary` in the review packet.
- `src/engine/orchestrator/evidence/review-packet/review-packet.ts:14` writes `review-packet.json`.

Impact:

- Failed lint/typecheck/test output can include API keys, bearer tokens, DB URLs, private-key snippets, or env dumps.
- Those values persist in `evidence.json` and `review-packet.json`, independent of transcript persistence and event sinks.

Fix:

- Redact validation failure text before assigning `ValidationResult.error`.
- Cap retained length and store structured failure metadata instead of raw stderr/stdout.
- Apply the same redaction to MCP-provided validation `errorSummary`.
- Add tests asserting `evidence.json` and `review-packet.json` redact common secret formats.

Why not duplicate:

- Existing P0-5 covers validation errors flowing to `session.jsonl`, stdout JSON, and OTel event sinks.
- This is a separate durable artifact path through the evidence/review-packet pipeline.

### P1-51: `start --detach` does not set the active-session pointer

Evidence:

- `src/cli/commands/start.ts:143` enters the detached branch.
- `src/cli/commands/start.ts:152` generates a detached session ID.
- `src/cli/commands/start.ts:154` creates the session directory.
- `src/cli/commands/start.ts:155` persists readiness.
- `src/cli/commands/start.ts:159` spawns the server.
- The detached branch does not call `beginSession()` or `writeActive()`.
- `src/cli/commands/start.ts:217` shows the normal interactive path does call `beginSession()`.
- `src/core/sessions/lifecycle.ts:58` shows `beginSession()` writes `.diptych/active`.

Impact:

- After `diptych start --detach`, default active-session commands can fail or target a stale previous session.
- Affected commands include `diptych status`, `resume`, `handoff`, `snapshot`, and `mcp serve` without `--session`.

Fix:

- Before spawning the detached server, clear stale active state and write `.diptych/active` to the detached session ID.
- Let existing final-save cleanup clear it when the server completes.

Why not duplicate:

- This is not first-run setup orphaning and not `/handoff` after completion.
- It is the detached start path never recording the running session as active.

### P1-52: detached `@image` attachments are silently lost

Evidence:

- `src/cli/commands/start.ts:129` parses `@file` inputs.
- `src/cli/commands/start.ts:134` stores image attachments in the in-process `attachmentsStore`.
- `src/engine/ipc/server-args.ts:12` serializes only session ID, project dir, feature, mode, config path, and overrides to the detached server process.
- `src/engine/ipc/server-entry.ts:138` calls `runWorkflow()` without `drainPendingAttachments`.
- `src/cli/headless.ts:77` passes `attachmentsStore.drain()` for `--json` and `--rpc` headless paths.

Impact:

- `diptych start --detach "fix UI" @screenshot.png` can start successfully while the planner never sees the screenshot.
- The plan can be wrong with no warning to the user.

Fix:

- Include attachment metadata in detached server args, persist attachments in the session dir, or reject image attachments with `--detach` until supported.

Why not duplicate:

- P1-43 covers first-run setup losing text context.
- P0-9 covers text attachment persistence.
- This is detached-mode image attachment loss across a process boundary.

### P1-53: MCP all-sessions discovery omits active/in-progress sessions

Evidence:

- `src/engine/mcp/discovery.ts:27` resolves `mcp serve --all-sessions` with `listAllSessions()`.
- `src/core/sessions/io.ts:62` looks for `summary.json` inside each session directory.
- `src/core/sessions/io.ts:64` includes a session only when `readSummaryFile(summaryPath)` succeeds.
- `src/core/sessions/io.ts:74` exposes that summary-only list as `listAllSessions()`.
- `src/engine/mcp/resolver.ts:228` uses `listAllSessions()` for the `mcp://diptych/sessions` resource.

Impact:

- An active or interrupted session without `summary.json` is invisible to `--all-sessions`.
- Default active-session MCP can expose a sessions-list resource that returns an empty or incomplete list while other resources exist.

Fix:

- Make MCP discovery enumerate `.diptych/sessions/<id>` directories directly.
- Include state/lockfile-only sessions with summary fields optional.
- Add tests for active, interrupted, and completed sessions.

Why not duplicate:

- This is not MCP tool scoping or MCP HTTP test coverage.
- It is a resource discovery/data-truth bug for live handoff workflows.

### P1-54: dirty working-tree conflict baseline reads every changed file concurrently

Evidence:

- `src/engine/orchestrator/changed-files-baseline.ts:18` reads changed files fully.
- `src/engine/orchestrator/changed-files-baseline.ts:27` captures the baseline.
- `src/engine/orchestrator/changed-files-baseline.ts:29` runs all file reads in `Promise.all`.
- `src/engine/orchestrator/task/loop.ts:86` runs this before task execution.
- `src/engine/orchestrator/changed-files-baseline.ts:35` refreshes the same baseline path for changed files since the baseline.

Impact:

- Repos with many dirty files or large unignored generated assets can spike memory and file descriptors.
- Implementation can stall even when those dirty files are unrelated to the task.

Fix:

- Bound concurrency.
- Skip or hash large/generated files by metadata or streaming.
- Scope conflict baselines to relevant paths where possible.

Why not duplicate:

- This is separate from the existing snapshot hashing finding.
- It runs through user-edit conflict detection even when snapshots are disabled.

### P1-55: post-hook sink can spawn unbounded, unawaited work

Evidence:

- `src/engine/hooks/sink.ts:9` creates the hook sink.
- `src/engine/hooks/sink.ts:16` fires hook work with `void runBuiltinsAndEntriesAndReport(...)`.
- `src/engine/hooks/sink.ts:62` maps many workflow events to post-hooks.
- `src/engine/hooks/sink.ts:64` through `src/engine/hooks/sink.ts:70` include task completion, validation completion, commit, plan done, workflow complete, and errors.
- `src/engine/hooks/dispatch.ts:27` runs command hooks through subprocess spawning.
- `src/engine/hooks/dispatch.ts:68` times out module hooks by racing a promise, but does not isolate or cancel the underlying module work.

Impact:

- Slow post-hooks can pile up across many tasks.
- `on_complete` hooks can keep headless or detached processes alive after the workflow appears finished.

Fix:

- Make post-hooks lifecycle-managed.
- Add a bounded queue, cancellation/drain on shutdown, and subprocess/worker isolation for module hooks.

Why not duplicate:

- Existing hook findings cover trust and execution boundaries.
- This is resource lifecycle and concurrency after hooks are enabled.

### P1-56: `start --detach` timeout does not clean up the spawned server

Evidence:

- `src/engine/ipc/spawn-server.ts:79` resolves a timeout when the server does not become ready.
- `src/engine/ipc/spawn-server.ts:106` spawns the detached server.
- `src/engine/ipc/spawn-server.ts:110` unreferences it before readiness succeeds.
- `src/engine/ipc/spawn-server.ts:113` returns the readiness result without terminating the child on timeout.

Impact:

- A server that hangs before accepting the socket can survive after the CLI reports failure.
- This leaves an orphan background process/session.

Fix:

- Keep the child referenced until ready.
- On timeout or failed readiness, terminate the child process group and mark the session failed.

Why not duplicate:

- This is distinct from prior session-orphan and native-startup findings.
- It is detached launcher process cleanup.

### P1-57: timed-out generic commands kill only the direct child

Evidence:

- `src/lib/process/spawn.ts:6` sets the default command timeout to 60 seconds.
- `src/lib/process/spawn.ts:119` starts the timeout.
- `src/lib/process/spawn.ts:120` calls `killProcess(proc)` without group mode.
- `src/lib/process/registry.ts:21` supports group killing only when requested.
- `src/lib/process/registry.ts:24` keeps group mode disabled unless `options.group` is set.
- `src/engine/orchestrator/validation.ts:176` uses this command path for validation.

Impact:

- `npm test`, `npx prettier`, or model-discovery commands that spawn children can leave grandchildren running after timeout.

Fix:

- Run timeout-managed commands in their own process group and kill the group.
- Alternatively use a process-tree cleanup helper with tests for child and grandchild termination.

Why not duplicate:

- Existing backpressure/output findings are about I/O and retained strings.
- This is subprocess tree cleanup on timeout.

### P1-58: image attachments have no total/count cap before base64 encoding

Evidence:

- `src/core/schemas/attachment.ts:4` allows each image to be up to 10 MB.
- `src/stores/workflow/attachments.ts:20` allows unbounded pending attachments.
- `src/engine/orchestrator/planning/run.ts:60` drains all pending attachments before planning.
- `src/engine/streaming/attachments.ts:9` encodes all images concurrently.
- `src/engine/streaming/attachments.ts:12` reads each image into memory and converts it to base64.
- `src/engine/providers/openai-stream.ts:61` embeds encoded images into OpenAI payloads.
- `src/engine/providers/anthropic/stream.ts:207` embeds encoded images into Anthropic payloads.

Impact:

- Many valid screenshots can create hundreds of MB of Buffers and base64 strings before the request is sent.

Fix:

- Enforce max attachment count and total bytes.
- Encode sequentially or with low concurrency.
- Reject oversized aggregate payloads before planner invocation.

Why not duplicate:

- This is separate from streamed text, event persistence, and backpressure findings.
- It is pre-request image payload memory.

---

## Updated Final Baseline For Next Loop (After Fifth Loop)

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.
- Fourth-loop findings.
- Fifth-loop findings P0-16 and P1-48 through P1-58.

Any further audit agent must first read this whole file and exclude every finding listed here. Because the fifth loop still found new P0/P1 issues, the audit is not done. Future loops must be stricter again: report only new, non-duplicate P0/P1 findings, or explicitly state no-new-P0/P1 for that lane after checking against this file.

---

## Sixth Loop Findings - 2026-05-25

Agents were explicitly instructed to read this whole file first and exclude all original, second-loop, third-loop, fourth-loop, and fifth-loop findings before reporting anything. MCP/IPC security and test-behavior lanes reported no new P0/P1 findings. The remaining lanes found the following new non-duplicate P1 issues.

### P1-59: repo-map leaks hardcoded secrets into `.diptych` cache and planner prompts

Evidence:

- `src/engine/orchestrator/planning/run.ts:50` enables repo-map generation unless `config.codebase?.enabled === false`.
- `src/core/schemas/codebase.ts:4` defaults repo-map support to enabled.
- `src/core/schemas/codebase.ts:6` defaults the cache directory to `.diptych`.
- `src/engine/codebase/parse.ts:81` extracts declaration signatures.
- `src/engine/codebase/parse.ts:85` keeps the full declaration text when the node has no `{`.
- `src/engine/codebase/cache.ts:44` persists `symbols_json`.
- `src/engine/codebase/format.ts:6` prints `sym.signature`.
- `src/engine/planners/base.ts:29` wraps repo-map content into planner input.

Impact:

- A top-level `const OPENAI_API_KEY = "..."`, database URL, bearer token, password, or private-key string can be copied into `.diptych/repomap.sqlite` and sent to the planner/provider by default.

Fix:

- Strip lexical declaration initializers before caching and formatting signatures.
- Store only name/type/export/line metadata unless the signature is proven safe.
- Add redaction tests for API keys, bearer tokens, DB URLs, passwords, and private keys.

Why not duplicate:

- Existing privacy findings cover current code blocks, diffs, attachments, argv prompts, validation artifacts, evidence packets, and logs.
- This is the default repo-map symbol extraction/cache/prompt path.

### P1-60: crash in non-resumable phases can deadlock the project

Evidence:

- `src/core/sessions/lifecycle.ts:26` implements `isSessionLive`.
- `src/core/sessions/lifecycle.ts:32` treats any phase other than `complete` or `idle` as live.
- `src/core/sessions/guards.ts:8` refuses to clear an active session when `isSessionLive` returns true.
- `src/core/phases.ts:40` defines resumable phases but excludes early live phases such as `researching`, `specifying`, and `planning`.
- `src/cli/commands/resume.ts:46` rejects non-resumable saved states.

Impact:

- A SIGKILL, power loss, or process crash during an early non-resumable phase can leave `.diptych/active` pointing at a session that `start` refuses to clear and `resume` refuses to resume.
- The user must manually edit `.diptych` to recover the project.

Fix:

- Distinguish live process ownership from non-terminal state.
- Use lockfile/process liveness checks before treating the active session as live.
- Mark dead non-resumable sessions failed and clear or replace the active pointer with a diagnostic.

Why not duplicate:

- This is not detached-session active pointer handling, first-run setup orphaning, or detached timeout cleanup.
- It is stale active-session crash recovery for non-resumable phases.

### P1-61: explicit `continue <session>` does not claim active session ownership

Evidence:

- `src/cli/commands/continue.ts:91` resolves the requested target session.
- `src/cli/commands/continue.ts:139` resumes headless mode with that session ID.
- `src/cli/commands/continue.ts:144` resumes RPC mode with that session ID.
- `src/cli/commands/continue.ts:154` initializes the TUI workflow with `resumeState` and `sessionId`.
- No `writeActive` call appears in the continue path.
- `src/engine/orchestrator/session-lifecycle.ts:54` clears the active pointer on final save unless `preserveActive` is set.
- `src/engine/orchestrator/run/run.ts:35` generates a new session ID when no session ID is passed, but does not claim active ownership for an explicit resumed session.

Impact:

- `continue <id>` can run the requested session while `status`, later `resume`, and active-session commands still point to a stale or null active session.
- If the continued session stops for recovery, the default recovery path can be lost or confusing.

Fix:

- When resuming a non-running explicit session, atomically write `.diptych/active` to that session before workflow start.
- On final save, clear active only if it still equals the finishing session.

Why not duplicate:

- This is not `start --detach` active pointer handling, first-run active mismatch, or post-completion `/handoff`.
- It is the explicit `continue <session>` ownership path.

### P1-62: auto snapshot configs can make `/reject-run` a no-op

Evidence:

- `src/core/schemas/config.ts:24` allows `snapshots.auto.preTask`, `postTask`, and `preFinalReview` independently.
- `src/engine/orchestrator/task/loop.ts:25` defines `maybeAutoSnapshot`.
- `src/engine/orchestrator/task/loop.ts:47` records a snapshot in the run ledger only when `recordInRunLedger` is true.
- `src/engine/orchestrator/task/loop.ts:143` creates `pre-task-*` snapshots without `recordInRunLedger`.
- `src/engine/orchestrator/task/loop.ts:186` records `post-task-*` snapshots in the run ledger only when `postTask` is enabled and the task succeeded.
- `src/engine/orchestrator/final-review.ts:44` records `pre-final-review` snapshots only when that specific option is enabled.
- `src/engine/snapshots/store.ts:227` makes the first snapshot the baseline.
- `src/engine/snapshots/run.ts:236` returns `empty` when no run ledger exists.

Impact:

- With `preTask` only, snapshots exist but `/reject-run` has no run ledger and returns empty.
- With only a later snapshot option enabled, the first snapshot can become the baseline after work has already happened, so reject compares the run against a post-change baseline and can restore nothing.

Fix:

- Create an immutable run baseline before the first implementer mutation whenever run rejection is available.
- Record all run auto-snapshots in the run ledger with their role.
- Validate config combinations or disable `/reject-run` with a clear warning when no pre-mutation baseline exists.

Why not duplicate:

- Existing snapshot findings cover traversal/symlink safety, package size, and performance.
- This is run-rejection correctness under valid auto-snapshot configuration.

### P1-63: command-palette session resume starts a fresh workflow

Evidence:

- `src/features/palette/sources.ts:114` handles interrupted sessions.
- `src/features/palette/sources.ts:115` navigates to `workflow` with only the feature name, dropping `resumeState` and `sessionId`.
- `src/features/sessions/picker-select.ts:13` loads saved workflow state.
- `src/features/sessions/picker-select.ts:23` navigates with `{ resumeState, sessionId }`.
- `src/features/workflow/hooks/use-workflow-runner.ts:82` reads the optional `resumeState`.
- `src/features/workflow/hooks/use-workflow-runner.ts:83` reads the optional initial session ID.
- `src/engine/orchestrator/run/run.ts:35` generates a new session ID when one is missing.

Impact:

- Selecting an interrupted session from the command palette can start a new expensive workflow instead of resuming the saved interrupted run.

Fix:

- Share one resume-selection helper between the sessions picker and command palette.
- Add behavior coverage for selecting interrupted sessions from both surfaces.

Why not duplicate:

- This is not detached active-session handling or broad recovery-driver drift.
- It is a separate TUI command-palette boundary.

### P1-64: global install cannot see project-local Agent SDK peer

Evidence:

- `README.md:64` documents `npm install -g diptych`.
- `package.json:44` declares `@anthropic-ai/claude-agent-sdk` as a peer dependency.
- `package.json:48` marks that peer optional.
- `src/engine/agent-sdk-backend.ts:57` uses a bare dynamic `import('@anthropic-ai/claude-agent-sdk')`.
- `src/engine/agent-sdk-backend.ts:62` tells users to run `npm install @anthropic-ai/claude-agent-sdk`.
- `docs/CONFIGURATION.md:212` says the SDK is used when installed as a peer dependency.

Impact:

- A globally installed `diptych` resolves the bare import from the global package location, not from the customer project.
- Installing the SDK in the project as instructed can still leave the global CLI unable to load it.

Fix:

- Make the SDK an optional dependency of the CLI package, document global installation in the same prefix, or resolve the SDK from `projectDir` via `createRequire`.
- Add a smoke test for globally installed `diptych` with a project-local SDK.

Why not duplicate:

- Existing optional peer coverage notes the unbounded peer version range.
- This is the module-resolution failure under the documented global CLI install path.

### P1-65: project config can silently downgrade approval policy

Evidence:

- `src/core/config/load/load.ts:107` auto-loads `.diptych/config.yaml`.
- `src/core/config/load/load.ts:96` carries `approval` from migrated config into runtime config.
- `src/core/schemas/config.ts:65` accepts `approval.enabled`, `approval.tiers`, and `approval.allowedPaths`.
- `src/core/schemas/config.ts:98` accepts `workflow.approve`.
- `src/core/config/runtime/resolve.ts:28` lets project config override mode-default approval levels.
- `src/engine/orchestrator/approval/tiered-approval.ts:58` immediately allows every action when approval is disabled.
- `src/engine/orchestrator/approval/tiered-approval.ts:71` auto-allows actions classified into downgraded `auto` tiers.

Impact:

- An untrusted repository can carry `.diptych/config.yaml` that disables approval, sets `workflow.approve: none`, widens `allowedPaths`, or downgrades destructive/network/package/write tiers without a separate trust confirmation.

Fix:

- Treat approval-reducing project config as trust-sensitive.
- Fail closed or require explicit CLI/session confirmation when project config disables approval, lowers tiers, widens write scope, or reduces `workflow.approve` below mode defaults.

Why not duplicate:

- Existing trust-boundary findings cover custom runner execution, validation execution, argv exposure, and `apiBase`.
- This is a distinct policy-bypass surface in auto-loaded project config.

### P1-66: built-in runners get autonomous side-effect permissions outside Diptych approval

Evidence:

- `src/engine/cli-tools.ts:51` runs Codex with `--full-auto`.
- `src/engine/cli-tools.ts:59` runs the Codex implementer with `--full-auto`.
- `src/engine/cli-tools.ts:92` runs Aider with `--yes-always`.
- `src/engine/cli-tools.ts:109` runs the Aider implementer with `--yes-always`.
- `src/engine/cli-tools.ts:121` runs Copilot with `--allow-all`.
- `src/engine/cli-tools.ts:129` runs the Copilot implementer with `--allow-all`.
- `src/engine/cli-tools.ts:150` runs Kilo with `--yolo`.
- `src/engine/agent-sdk-backend.ts:10` allows planner `Write`.
- `src/engine/agent-sdk-backend.ts:11` allows implementer `Bash`.
- `src/engine/agent-sdk-backend.ts:169` defaults SDK permission mode to `acceptEdits`.

Impact:

- Built-in `cli` and `agent-sdk` runners can perform destructive commands, network calls, package installs, or writes before Diptych's own approval classifier sees an action.
- Changed-file gating only reviews resulting file diffs, not external side effects.

Fix:

- Remove autonomous flags by default.
- Make planners read-only.
- Remove `Bash` and write-capable SDK tools unless explicitly trusted.
- Route runner tool calls through permission callbacks or sandboxing before execution.

Why not duplicate:

- Existing findings cover project-local custom runner commands, validation commands, argv prompt exposure, and `apiBase`.
- This is about built-in runner defaults and SDK permissions.

### P1-67: write-capable implementers can outlive cancel or timeout

Evidence:

- `src/engine/implementers/cli.ts:17` computes a timeout for CLI implementers.
- `src/engine/implementers/cli.ts:27` special-cases `claude-code`.
- `src/engine/implementers/cli.ts:28` calls `runClaudeOneShot` without the timeout or `AbortSignal`.
- `src/engine/implementers/agent-sdk.ts:17` accepts invoke options.
- `src/engine/implementers/agent-sdk.ts:18` drops `signal`.
- `src/engine/implementers/agent-sdk.ts:19` invokes the backend without cancellation.
- `src/engine/agent-sdk-backend.ts:143` defines backend invoke options without a signal.
- `src/engine/agent-sdk-backend.ts:192` processes the SDK stream without cancellation.
- `src/engine/implementers/shell.ts:14` omits a timeout when building the command-based implementer.
- `src/engine/runners/command-based.ts:66` uses timeout handling only when `opts.timeout` is defined.
- `src/engine/runners/command-based.ts:94` otherwise runs `spawnAndCollect`.

Impact:

- Cancel, SIGINT, RPC abort, or hung implementers can leave file-writing Claude, Agent SDK, or shell work running after Diptych thinks the turn stopped.

Fix:

- Thread `AbortSignal` through Claude one-shot and Agent SDK paths.
- Enforce `IMPLEMENTER_TIMEOUT_MS` for all implementer backends.
- Add tests for hanging subprocess children and hanging async SDK streams.

Why not duplicate:

- Existing planner abort coverage is about planner paths.
- Existing timeout cleanup coverage is about killing only direct subprocess children after a timeout.
- This is missing implementer timeout/cancel wiring on write-capable execution paths.

### P1-68: resume rebuild materializes and resends unbounded prior transcript

Evidence:

- `src/engine/streaming/transcript-buffer.ts:18` flushes transcript chunks every 16 KB.
- `src/engine/streaming/transcript-buffer.ts:19` persists each chunk as a message entry.
- `src/core/sessions/log-reader.ts:50` exposes compacted-message reading.
- `src/core/sessions/log-reader.ts:52` first reads every log entry into memory.
- `src/core/sessions/log-reader.ts:56` returns all messages when no summary exists.
- `src/engine/orchestrator/resume-context.ts:59` rebuilds resume context from persisted transcript.
- `src/engine/orchestrator/resume-context.ts:66` assigns rebuilt messages into `resumeHolder.messages`.
- `src/engine/planners/base.ts:113` prepends prior messages to the prompt for non-conversational planners.
- `src/engine/planners/base.ts:118` passes prior messages through for planners that consume them directly.
- `src/core/config/load/load.ts:42` defaults transcript persistence to true.
- `src/core/schemas/config.ts:110` also defaults `persistTranscript` to true.

Impact:

- Long interrupted sessions can spike memory and resend huge prompts on resume or session-expiry recovery.
- That can cause context failures and unexpectedly high API bills.

Fix:

- Stream resume log processing.
- Keep only a bounded tail plus the latest summary.
- Enforce byte/token budgets before assigning `resumeHolder.messages`.
- Compact before full materialization when the transcript is too large.

Why not duplicate:

- Existing streaming/render/event persistence findings cover live streaming and retained render/event state.
- This is the later session recovery replay path.

### P1-69: Anthropic idle timeout does not cancel the stalled HTTP stream

Evidence:

- `src/utils/with-timeout.ts:47` races `iterator.next()` against an idle timer.
- `src/utils/with-timeout.ts:59` only calls async iterator `return()` after timeout.
- `src/engine/providers/anthropic/stream.ts:145` can remain blocked in `reader.read()`.
- `src/engine/providers/anthropic/stream.ts:163` cleanup only releases the reader lock.
- `src/engine/providers/anthropic/stream.ts:254` passes only the external signal to `fetch`.
- `src/engine/providers/anthropic/stream.ts:274` wraps the SSE reader with the idle timeout after the HTTP request has started.

Impact:

- A stalled Anthropic stream can throw an idle-timeout error to the workflow while the underlying response/socket remains pending.
- Repeated retries can leak file descriptors or sockets.

Fix:

- Create a per-request `AbortController`.
- Abort the HTTP request on idle timeout.
- Call `reader.cancel()` on early close.
- Test with a never-ending `ReadableStream`.

Why not duplicate:

- Existing startup discovery timeout cleanup is before model request startup.
- Existing planner abort propagation is about external abort signals.
- This is provider stream idle-timeout cleanup after the Anthropic HTTP request has started.

---

## Updated Final Baseline For Next Loop (After Sixth Loop)

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.
- Fourth-loop findings.
- Fifth-loop findings P0-16 and P1-48 through P1-58.
- Sixth-loop findings P1-59 through P1-69.

Any further audit agent must first read this whole file and exclude every finding listed here. Because the sixth loop still found new P1 issues, the audit is not done. Future loops must be stricter again: report only new, non-duplicate P0/P1 findings, or explicitly state no-new-P0/P1 for that lane after checking against this file.

---

## Seventh Loop Findings - 2026-05-25

Agents were explicitly instructed to read this whole file first and exclude every finding through P1-69 before reporting anything. The local HTTP/MCP security lane reported no-new-P0/P1. The clean-code staging lane reported a direct-write staging copy issue that is already covered by P1-46 and was not renumbered. The following findings were kept because they describe new customer-impacting paths or contracts not already covered above.

### P1-70: published global installs are not reproducible against the audited dependency graph

Evidence:

- `package.json:52` starts runtime dependencies with ranged semver specs.
- Examples include `better-sqlite3` at `package.json:58`, `commander` at `package.json:60`, and `openai` at `package.json:64`.
- `package.json:74` declares optional `tree-sitter-wasms` with a ranged spec.
- The repo has `package-lock.json`, but no `npm-shrinkwrap.json`.
- Local `npm pack --dry-run --json --ignore-scripts --silent` showed `hasRootPackageLock: false`, `hasShrinkwrap: false`, `bundled: 0`, `entryCount: 7044`, and `unpackedSize: 26510777`.

Impact:

- A future `npm install -g diptych` installs a dependency graph that is not locked by the repo's audited `package-lock.json`.
- Compatible runtime or transitive releases can change installed CLI behavior independently of the Diptych release artifact.
- This weakens customer reproducibility, support debugging, and supply-chain review after handoff.

Fix:

- After resolving known runtime dependency advisories, publish a reproducible runtime graph with `npm-shrinkwrap.json` or exact runtime dependency pins.
- Add a release smoke test that installs the packed tarball into a temporary global prefix and runs `npm ls --omit=dev`.
- Keep the shrinkwrap/package-content check aligned with the package allowlist from P0-1.

Why not duplicate:

- P0-6 covers currently vulnerable versions in the source lockfile.
- P0-1 and P0-3 cover package contents and package smoke coverage.
- P1-14 covers one wildcard optional peer, and P1-64 covers Agent SDK peer resolution.
- This is specifically the absence of a publishable runtime lock for global installs.

### P1-71: hook trust does not bind the hook executable content

Evidence:

- `src/core/hooks/trust.ts:17` hashes only the canonical hook config object.
- `src/core/hooks/trust.ts:34` trusts hooks when the stored config hash matches.
- `src/core/hooks/trust.ts:40` writes only `{ version, trusted_hash }`.
- Runtime execution later imports the current module target in `src/engine/hooks/load-module.ts:14`.
- Runtime command hooks spawn the current command path in `src/engine/hooks/dispatch.ts:27`.
- `docs/HOOKS-CONFIG.md:331` through `docs/HOOKS-CONFIG.md:334` document that future runs compare the stored config hash and only config edits invalidate trust.

Impact:

- After a user trusts `./.diptych/hooks/pre-task.js` or `./scripts/pre-task.sh` once, that file can change without changing `.diptych/config.yaml`.
- Diptych will execute the new bytes without another trust prompt.
- Hook trust becomes "trust this path string forever", which is weak across branch switches, malicious PRs, compromised hooks, or any earlier write-capable runner.

Fix:

- Store and verify a hook trust manifest for the resolved hook set: config hash plus resolved realpath and content hash for project-local module/script targets.
- Re-check immediately before execution.
- Reject symlink escapes and path traversal.
- Require an explicit policy for absolute paths and PATH-resolved commands.

Why not duplicate:

- P0-4 covers missing or misplaced hook trust enforcement, especially auto-discovered hooks and non-TUI paths.
- P1-3 covers `.diptych` control-plane writes.
- This still applies after trust is enforced correctly: trusted hook target files can change while the trusted config hash stays unchanged.

### P1-72: default planner project context leaks raw README and package scripts

Evidence:

- `src/engine/planners/context.ts:16` copies raw `package.json` script command bodies into project context.
- `src/engine/planners/context.ts:24` formats those script commands directly into the planner context.
- `src/engine/planners/context.ts:32` reads `README.md`.
- `src/engine/planners/context.ts:33` through `src/engine/planners/context.ts:35` copy the first 50 README lines verbatim.
- Full planning sends that context at `src/engine/planners/base.ts:216` and `src/engine/planners/base.ts:222`.
- Quick and instant planning build prompts from the same context at `src/engine/planners/base.ts:376` through `src/engine/planners/base.ts:379`.

Impact:

- API keys, bearer tokens, private registry tokens, database URLs, or sensitive internal text in README/scripts are sent to the external planner by default.
- The same content can be echoed into durable planning artifacts or transcripts.

Fix:

- Redact `projectContext` before prompt construction.
- Omit script command bodies by default, or include only script names and high-level metadata.
- Add tests with `DATABASE_URL`, bearer tokens, `sk-*`, private keys, and private registry tokens in README/scripts.

Why not duplicate:

- P1-59 covers repo-map symbol extraction and cache leakage.
- P0-9 covers `@file` attachment persistence.
- P1-40, P1-45, and P1-47 cover diff/current-code/argv prompt leakage.
- This is the separate automatic README/package-scripts project-context path.

### P1-73: MCP evidence tools persist and echo arbitrary secret-bearing agent text

Evidence:

- `src/engine/mcp/tool/schemas.ts:7` accepts arbitrary `observedEvidence` strings.
- `src/engine/mcp/tool/schemas.ts:14`, `src/engine/mcp/tool/schemas.ts:23`, and `src/engine/mcp/tool/schemas.ts:38` accept arbitrary `message`, `summary`, and `error` strings.
- `src/engine/mcp/tool/operations.ts:115` stores reported evidence raw.
- `src/engine/mcp/tool/operations.ts:141` stores progress messages raw.
- `src/engine/mcp/tool/operations.ts:168` stores completion summaries raw.
- `src/engine/mcp/tool/operations.ts:229` stores reported errors raw.
- `src/engine/orchestrator/evidence/persistence.ts:23` writes the ledger to `evidence.json`.
- `src/engine/mcp/resolver.ts:300` through `src/engine/mcp/resolver.ts:303` exposes `evidence.json` as an MCP resource.
- `src/engine/orchestrator/evidence/review-packet/sections.ts:77` through `src/engine/orchestrator/evidence/review-packet/sections.ts:80` propagates observed evidence into review packets.

Impact:

- An implementer or MCP client can paste stdout/stderr, provider errors, source snippets, tokens, or database strings into progress/evidence/error fields.
- Diptych then persists and re-exposes those strings independently of transcript settings.
- Tool responses also echo some raw text, such as progress messages.

Fix:

- Add one sanitizer/redaction layer for every MCP text field before ledger writes and tool responses.
- Enforce length caps on all agent-supplied MCP evidence strings.
- Cover every MCP evidence/progress/done/error tool with redaction tests.

Why not duplicate:

- P1-50 covers validation failure text and MCP `errorSummary`.
- P0-5 covers validation event sinks.
- This covers the remaining MCP evidence-tool text fields plus response echo.

### P1-74: shutdown loses process-group cleanup for detached child runners

Evidence:

- `src/lib/process/spawn.ts:174` through `src/lib/process/spawn.ts:180` start timeout-managed commands as detached processes.
- `src/lib/process/spawn.ts:184` group-kills a timed-out process.
- `src/lib/process/registry.ts:71` through `src/lib/process/registry.ts:74` implement global shutdown cleanup with `killProcess(proc)` and no group option.
- The active-process registry stores only `ChildProcess`, so detached/group ownership is not preserved for shutdown.

Impact:

- On SIGINT, SIGTERM, workflow failure, or process cleanup, Diptych can kill only the detached runner leader.
- Grandchildren spawned by CLI tools, validation commands, or hooks can continue running after Diptych thinks it stopped.
- This can leave writes, package installs, test processes, or model CLIs alive in the project.

Fix:

- Register process metadata, including whether a process owns a group.
- Make `killAllProcesses()` group-kill detached/group-managed children.
- Wait and escalate based on close/liveness instead of only signal dispatch.
- Add tests with a child process that leaves a grandchild running.

Why not duplicate:

- P1-57 covers timeout cleanup killing only direct children.
- P1-67 covers missing implementer timeout/cancel wiring.
- This is the global shutdown path losing group metadata for already-detached runner processes.

### P1-75: documented planner timeout is accepted but not enforced

Evidence:

- `src/core/schemas/runner-fields.ts:49` through `src/core/schemas/runner-fields.ts:55` include a common `timeout` field for generation runners.
- `docs/PLANNERS-AND-IMPLEMENTERS.md:357` documents planner timeout configuration.
- `src/engine/planners/command-invoke.ts:20` through `src/engine/planners/command-invoke.ts:27` define command-based planner config without timeout.
- `src/engine/planners/cli.ts:92` through `src/engine/planners/cli.ts:98` call `spawnAndCollect` without timeout or signal.
- `src/engine/planners/api.ts:37` through `src/engine/planners/api.ts:42` call `dispatchStreamCompletion` without a timeout controller.

Impact:

- A hung planner subprocess or stalled planner API stream can run indefinitely despite configured `planner.timeout`.
- Users can believe the timeout protects expensive planner calls while the actual backend ignores it.

Fix:

- Thread `planner.timeout` through the planner interface.
- Apply timeout-aware `AbortController` handling for API/SDK planners.
- Apply timeout and process-group handling for CLI/shell/agent planners.
- Add tests for a hanging planner subprocess and a never-ending planner stream.

Why not duplicate:

- P1-38 covers external abort propagation.
- P1-67 covers implementer timeout/cancel gaps.
- This is the separate documented planner timeout contract being accepted and then dropped.

### P1-76: RPC abort does not resolve pending gates

Evidence:

- `src/cli/rpc/gates.ts:5` through `src/cli/rpc/gates.ts:13` implement gates with only a resolver and no reject/abort path.
- `src/cli/rpc/run.ts:121` through `src/cli/rpc/run.ts:124` wait for recovery actions via `recoveryGate.wait()`.
- `src/cli/rpc/callbacks.ts:26` through `src/cli/rpc/callbacks.ts:31` await approval callbacks.
- `src/cli/rpc/callbacks.ts:33` through `src/cli/rpc/callbacks.ts:39` await conflict/question message gates.
- `src/cli/rpc/callbacks.ts:64` through `src/cli/rpc/callbacks.ts:70` await task-review message gates.
- `src/cli/rpc/run.ts:205` through `src/cli/rpc/run.ts:207` handle abort by calling the current abort handler and aborting the controller, but do not resolve pending gates.

Impact:

- `diptych start --rpc` can acknowledge an abort but remain hung when it is waiting for approval, clarification, task review, user-edit conflict, or recovery input.
- Automation sees an accepted abort command without reliable process termination.

Fix:

- Make RPC gates abort-aware.
- Reject or resolve every pending wait on abort with safe deny/abort defaults.
- Clear queued recovery actions when aborting.
- Add RPC tests for abort during approval, question, task review, and recovery waits.

Why not duplicate:

- Existing abort findings cover planner and implementer backends.
- This is the RPC control-plane gate lifecycle around waits that are not model subprocesses or provider streams.

### P1-77: no repo-declared release workflow gates customer behavior

Evidence:

- `package.json:28` defines `test-ci` as local typecheck, lint, and unit/integration test execution.
- `vitest.config.ts:5` includes source, integration, helper, and eval tests.
- `vitest.config.ts:6` excludes `dist`.
- `.github` contains only documentation/prompt files and no `.github/workflows/*` workflow file.
- `docs/TESTING.md:437` says several customer-critical flows live outside the automated suite.
- `docs/TESTING.md:453` through `docs/TESTING.md:493` list manual headless, hook, OTel, and fresh install checks.

Impact:

- Release-critical package, install, built `dist`, docs drift, hook, telemetry, and fresh-checkout regressions can ship without a repo-declared gate.
- Contributors have no committed CI/release workflow that defines the minimum customer-handoff bar.

Fix:

- Add a committed CI/release workflow running `npm ci`, typecheck, lint, unit/integration tests, selected true CLI/package smoke tests, package-content checks, docs drift checks, production audit, and license gates.
- Move the highest-value manual checks from `docs/TESTING.md` into automated scripts.

Why not duplicate:

- P1-9 covers missing invariant checks inside `test-ci`.
- P1-31 covers e2e tests not being a release gate and bypassing customer CLI entrypoints.
- P0-3 covers the package CLI path being untested.
- This is the broader absence of any repo-declared workflow that enforces the combined handoff gate.

### P1-78: snapshot rollback recovery lacks command-level behavior coverage

Evidence:

- `src/cli/commands/snapshot.test.ts:35` through `src/cli/commands/snapshot.test.ts:62` cover `snapshot create` and list visibility.
- `src/cli/commands/snapshot.test.ts:64` through `src/cli/commands/snapshot.test.ts:87` cover `snapshot list`.
- `src/cli/commands/snapshot.test.ts:89` through `src/cli/commands/snapshot.test.ts:103` cover session resolution only for `create` and `list`.
- `src/cli/commands/snapshot.ts:98` through `src/cli/commands/snapshot.ts:104` define the public `snapshot restore` command and `--force`.
- `src/cli/commands/snapshot.ts:121` through `src/cli/commands/snapshot.ts:145` define restore output, conflicts, missing files, force output, and conflict exit behavior.
- `src/cli/commands/snapshot.ts:149` through `src/cli/commands/snapshot.ts:170` define the public `snapshot diff` command.
- `src/engine/snapshots/restore.test.ts:86` covers engine restore directly.
- `src/core/runtime/commands/registry.test.ts:632` through `src/core/runtime/commands/registry.test.ts:694` test `/reject-run` against stubbed runtime callbacks, not the real snapshot path.

Impact:

- Public rollback behavior can regress at the CLI/runtime boundary while lower-level engine tests still pass.
- Wrong exit codes, session resolution, conflict warnings, `--force`, `snapshot diff`, or `/reject-run confirm` real wiring could break the customer recovery path.

Fix:

- Add behavior tests that create real snapshots and run Commander `snapshot restore`, `snapshot restore --force`, and `snapshot diff`.
- Add one `/reject-run confirm` test through a real app/runtime context with actual files and the real run ledger.

Why not duplicate:

- P1-62 covers auto snapshot configuration making `/reject-run` a no-op.
- Existing snapshot findings cover traversal/symlink/performance risks.
- This is command-level coverage for the public rollback contract.

### P1-79: failed workflows can exit as success in headless, RPC, and detached paths

Evidence:

- `src/engine/orchestrator/run/init.ts:116` through `src/engine/orchestrator/run/init.ts:119` return `{ ok: false, summary }` when the planner is unavailable.
- `src/engine/orchestrator/run/run.ts:104` through `src/engine/orchestrator/run/run.ts:113` catch runtime errors, set `sessionStatus = 'failed'`, build a summary, and continue returning normally.
- `src/cli/headless.ts:70` starts `runWorkflow()` without mapping failed summary/status to a non-zero process exit.
- `src/cli/rpc/run.ts:264` through `src/cli/rpc/run.ts:269` awaits `runWorkflow()` and then continues the RPC loop.
- `src/engine/ipc/server-entry.ts:204` calls cleanup with exit code `0` after `runWorkflow()` returns.

Impact:

- `start --json`, `resume --json`, `continue --json`, RPC, and detached runs can report process success even when no workflow actually ran or the engine failed.
- CI and automation can trust a false green result.

Fix:

- Make `runWorkflow()` return a discriminated terminal result or throw for failed/init-unavailable outcomes.
- Map failed terminal states to non-zero CLI exits and detached lockfile exit codes.
- Add headless, RPC, and detached tests for planner-unavailable and runtime-error paths.

Why not duplicate:

- Existing findings cover missing e2e/package gates, validation semantics, and detached timeout cleanup.
- This is a direct outcome propagation bug where real workflow failure is converted into process success.

### P1-80: live foreground sessions can be resumed concurrently

Evidence:

- Normal `start` writes only `.diptych/active` via `beginSession()` at `src/cli/commands/start.ts:217`.
- Foreground/TUI/headless runs do not write the detached `lockfile.json` ownership marker.
- `src/cli/commands/resume.ts:31` through `src/cli/commands/resume.ts:52` trust the active pointer and resumable state, then start another TUI/headless/RPC run without an ownership/liveness check.
- `src/cli/commands/continue.ts:94` through `src/cli/commands/continue.ts:110` only attach when a detached lockfile reports alive.
- `src/cli/commands/continue.ts:116` through `src/cli/commands/continue.ts:125` otherwise falls through to saved-state resume.

Impact:

- Running `diptych resume` or `continue <id>` from another terminal while a foreground workflow is still active can start a second planner/implementer against the same `state.json`.
- This can cause duplicate model spend, conflicting writes, and state corruption.

Fix:

- Add a per-session owner/lease for every workflow mode, not only detached IPC.
- Refuse resume/continue while the owner is alive.
- Allow recovery only after stale-owner detection or an explicit force option.

Why not duplicate:

- P1-60 covers stale active sessions after crashes being treated as live.
- This is the inverse: actually live foreground sessions have no ownership marker, so duplicate runners can start.

### P1-81: `last` and numeric aliases ignore normal sessions

Evidence:

- `src/cli/commands/last.ts:16` through `src/cli/commands/last.ts:20` select the latest session from `buildAliasedSessions()`.
- `src/cli/session-aliases.ts:27` through `src/cli/session-aliases.ts:40` include only session directories with a readable `lockfile.json`.
- Lockfiles are written by detached server startup, not normal foreground/headless sessions.
- `src/cli/commands/ps.ts:86` through `src/cli/commands/ps.ts:91` also assign displayed aliases only to rows that have lockfiles.

Impact:

- Ordinary TUI/headless sessions can have `state.json` and `summary.json`, while `diptych last` says no sessions found.
- Numeric aliases cannot resume those normal sessions.
- This breaks the documented "continue most recent session" customer path for non-detached runs.

Fix:

- Build aliases from session directories plus `summary.json`/`state.json`.
- Use lockfiles only to enrich running detached status.
- Add tests for `last`, `continue 1`, and `ps` aliases across completed, interrupted, foreground, headless, and detached sessions.

Why not duplicate:

- P1-53 covers MCP all-session discovery omitting active/in-progress sessions because it is summary-only.
- This is the CLI's opposite failure mode: `last` and numeric aliases use lockfile-only data and skip normal sessions.

---

## Updated Final Baseline For Next Loop (After Seventh Loop)

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.
- Fourth-loop findings.
- Fifth-loop findings P0-16 and P1-48 through P1-58.
- Sixth-loop findings P1-59 through P1-69.
- Seventh-loop findings P1-70 through P1-81.

Any further audit agent must first read this whole file and exclude every finding listed here. Because the seventh loop still found new P1 issues, the audit is not done. Future loops must report only new, non-duplicate P0/P1 findings, or explicitly state no-new-P0/P1 for that lane after checking against this file.

---

## Eighth Loop Findings - 2026-05-25

Scope:

- Eighth-loop agents were instructed to read this whole file through the "After Seventh Loop" baseline before auditing.
- The explicit exclusion set for this loop was P0-1 through P0-16, P1-1 through P1-81, and P2-1 through P2-24.
- The package/install lane reported no-new-P0/P1/P2 after checking the baseline.
- The clean-code/architecture lane reported no new P0/P1 and two new P2 architecture issues.
- No new P0 finding was reported in this loop.

### P1-82: MCP resource reads follow symlinks outside the session directory

Evidence:

- `src/engine/mcp/resolver.ts:192` through `src/engine/mcp/resolver.ts:199` define conditional artifact resources such as `spec.md`, `plan.md`, `evidence.json`, `drift-report.json`, `state.json`, and `summary.json`.
- `src/engine/mcp/resolver.ts:201` through `src/engine/mcp/resolver.ts:203` advertise a resource when `existsSync(join(sDir, entry.file))` succeeds.
- `src/engine/mcp/resolver.ts:260` through `src/engine/mcp/resolver.ts:268` read `spec.md` and `plan.md` via `readFileSafeAsync(join(sDir, ...))`.
- `src/engine/mcp/resolver.ts:272` through `src/engine/mcp/resolver.ts:278` read `tasks.md`.
- `src/engine/mcp/resolver.ts:290` through `src/engine/mcp/resolver.ts:297` read individual task blocks from `tasks.md`.
- `src/engine/mcp/resolver.ts:300` through `src/engine/mcp/resolver.ts:303` read `evidence.json`.
- `src/lib/fs.ts:66` through `src/lib/fs.ts:69` implement `readFileSafeAsync` as plain `readFile(path, "utf-8")`, with no `lstat`, regular-file check, no-follow behavior, or realpath confinement.
- `src/cli/commands/mcp.ts:85` through `src/cli/commands/mcp.ts:90` print the localhost MCP server config for external clients.

Impact:

- A repository can pre-place `.diptych/sessions/<id>/state.json`, `spec.md`, `plan.md`, `evidence.json`, or similar artifacts as symlinks to user-owned files outside the project.
- If the user serves MCP and gives a client the token, `resources/read` can expose outside-file contents over HTTP.

Fix:

- Require `lstat` regular-file checks and reject symlinks for every MCP-served artifact path before advertising or reading it.
- Verify artifact realpaths stay under the resolved session directory.
- Centralize this in a shared MCP artifact reader.
- Add tests for symlinked `state.json`, `spec.md`, and `evidence.json`.

Why not duplicate:

- P0-11 covers secure writes following `.diptych` symlinks.
- P1-21 covers broader control-plane directory hardening.
- P0-12 covers snapshot symlink/traversal behavior.
- This finding is the MCP HTTP resource-read exposure path.

### P1-83: provider and implementer failure text is persisted and re-prompted without a bounded secrets policy

Evidence:

- `src/engine/providers/anthropic/stream.ts:260` through `src/engine/providers/anthropic/stream.ts:262` read the full non-OK Anthropic response body and pass it into `streamError.httpStatus`.
- `src/lib/process/spawn.ts:236` through `src/lib/process/spawn.ts:237` accumulate full stdout and stderr strings.
- `src/lib/process/errors.ts:50` through `src/lib/process/errors.ts:54` store stderr detail in process errors.
- `src/engine/implementers/base.ts:166` through `src/engine/implementers/base.ts:172` convert caught implementer errors into `{ success: false, output, error: formatErrorWithHint(toErrorMessage(err)) }`.
- `src/engine/orchestrator/escalation/local-retries.ts:20` through `src/engine/orchestrator/escalation/local-retries.ts:23` publish `lastError`.
- `src/engine/orchestrator/events.ts:110` through `src/engine/orchestrator/events.ts:111` emit `task_retry` with the error text.
- `src/engine/spec/prompt-formatter.ts:193` through `src/engine/spec/prompt-formatter.ts:197` inject the previous error verbatim into the next retry prompt under `Error from previous attempt:`.

Impact:

- Provider APIs, local runners, hooks, or subprocesses can echo prompts, source snippets, environment dumps, API errors, or secrets into durable events/stdout JSON.
- The same raw error can later be sent back to planner or implementer models.
- Pattern redaction is not a data-minimization boundary and there is no size cap for this propagation path.

Fix:

- Separate raw diagnostics from sanitized persistence and sanitized retry-prompt text.
- Persist structured status/provider/code/request-id data plus a short redacted tail.
- Cap all persisted/prompted error text.
- Do not forward raw API response bodies or subprocess stdout/stderr to later models by default.
- Add tests with `DATABASE_URL`, bearer tokens, private keys, and large error bodies.

Why not duplicate:

- P0-5 and P1-50 cover validation output persistence and telemetry.
- P1-73 covers MCP evidence leakage.
- This finding covers provider and implementer failure paths that flow into retry/escalation prompting.

### P1-84: OTel exports non-validation content-bearing task and error fields

Evidence:

- `src/engine/orchestrator/run/init.ts:95` through `src/engine/orchestrator/run/init.ts:97` register the OTel sink when enabled.
- `src/engine/events/sinks/otel.ts:88` through `src/engine/events/sinks/otel.ts:98` send attributes such as `diptych.task.id`, `title`, `file`, and `action`.
- `src/engine/events/sinks/otel.ts:127` through `src/engine/events/sinks/otel.ts:130` send `diptych.task.skip_reason`.
- `src/engine/events/sinks/otel.ts:156` through `src/engine/events/sinks/otel.ts:164` record exceptions and warnings with raw event messages.
- `src/engine/events/types.ts:51` through `src/engine/events/types.ts:55` define task title/file/retry error fields.
- `src/engine/events/types.ts:98` through `src/engine/events/types.ts:99` define arbitrary warning/error messages.

Impact:

- With OTel enabled, task titles, file paths, hook/provider/approval messages, and skip reasons can leave `.diptych` retention boundaries and land in external telemetry.
- This is independent of transcript persistence settings.

Fix:

- Make OTel structural by default: counts, phases, durations, token/cost metrics, and hashed task IDs.
- Drop, redact, or cap task title/file, skip reason, warnings, and exception messages by default.
- Add an explicit `otel.includeContent` opt-in for content-bearing fields.

Why not duplicate:

- P0-9 covers feature text in OTel.
- P0-5 covers validation errors in OTel.
- P1-25 covers local JSONL/headless persistence.
- This finding is the wider non-validation OTel content surface.

### P1-85: snapshot locks can expire while a legitimate large snapshot or restore is still running

Evidence:

- `src/engine/snapshots/store.ts:144` sets `STALE_LOCK_MS = 60_000`.
- `src/engine/snapshots/store.ts:154` through `src/engine/snapshots/store.ts:177` delete and retry an existing lock when its mtime appears stale.
- `src/engine/snapshots/store.ts:220` through `src/engine/snapshots/store.ts:225` acquire the lock before `createSnapshot` collects, hashes, and copies tracked files.
- `src/engine/snapshots/restore.ts:75` through `src/engine/snapshots/restore.ts:80` acquire the same lock before restore.

Impact:

- Large repositories can take more than 60 seconds to snapshot or restore.
- A second operation can delete an active lock and run concurrently with the first operation.
- This can corrupt manifests/blobs or interleave restore with capture.

Fix:

- Use owner/token locking with PID liveness plus heartbeat/mtime refresh, or a proper advisory lock.
- Release locks only when the owner token matches.
- Add a test that simulates a long active snapshot whose lock mtime crosses the stale threshold.

Why not duplicate:

- P1-20 covers slow serial snapshot I/O.
- P0-12 covers snapshot symlink/traversal safety.
- This finding is a mutual-exclusion lifecycle failure.

### P1-86: text `@file` attachments have no aggregate byte or count cap and are concatenated synchronously

Evidence:

- `src/core/schemas/attachment.ts:4` defines a per-file 10 MB `MAX_ATTACHMENT_BYTES`.
- `src/cli/parse-at-files.ts:20` through `src/cli/parse-at-files.ts:30` collect unbounded `@` paths.
- `src/cli/parse-at-files.ts:98` through `src/cli/parse-at-files.ts:105` check individual file size and read text with `readFileSync`.
- `src/cli/parse-at-files.ts:111` through `src/cli/parse-at-files.ts:114` push all text segments and join them into one string.

Impact:

- Dozens of individually valid 10 MB text attachments can block CLI startup, create multiple huge string copies, and exhaust memory before the workflow begins.

Fix:

- Add aggregate text attachment byte and count limits.
- Reject or summarize excess attachment input before reading everything.
- Avoid repeated full-size string copies during attachment assembly.

Why not duplicate:

- P1-58 covers image attachment aggregate caps.
- P0-9 and P1-43 cover text attachment privacy and behavior.
- This finding is the text attachment resource-exhaustion path.

### P1-87: session tree recorder becomes quadratic over long workflows

Evidence:

- `src/engine/orchestrator/run/init.ts:88` through `src/engine/orchestrator/run/init.ts:91` create the event bus and subscribe `createTreeRecorderSink`.
- `src/engine/events/bus.ts:6` through `src/engine/events/bus.ts:10` run event sinks synchronously.
- `src/core/sessions/tree/store.ts:45` through `src/core/sessions/tree/store.ts:74` clone both `tree.entries` and `tree.children` maps on each append.
- `src/engine/events/sinks/tree-recorder.ts:177` through `src/engine/events/sinks/tree-recorder.ts:180` append cost updates as tree entries too.

Impact:

- Long sessions with many task, cost, retry, and progress events do O(N^2) map-copy work in the synchronous event path.
- This grows stalls and memory churn as workflows get longer.

Fix:

- Use mutable append-only recorder internals.
- Batch metadata writes where practical.
- Expose immutable snapshots only at UI/read boundaries.
- Add a large-event-count regression test or benchmark guard.

Why not duplicate:

- P1-7 covers synchronous JSONL persistence.
- P1-68 covers resume transcript materialization.
- This finding is the in-memory algorithmic scalability of the session tree recorder.

### P1-88: crashed detached sessions cannot be continued, and failed attach exits success

Evidence:

- `src/cli/commands/continue.ts:112` through `src/cli/commands/continue.ts:113` call `showCrashDiagnostic()` for crashed status before loading state at `src/cli/commands/continue.ts:119`.
- `src/engine/ipc/crash-diagnostic.ts:150` through `src/engine/ipc/crash-diagnostic.ts:162` print the diagnostic, wait for a key, and always `process.exit(0)`.
- `src/cli/commands/attach.ts:59` through `src/cli/commands/attach.ts:61` intend to show the diagnostic and then throw `cliError`, but the throw is unreachable because the diagnostic exits.

Impact:

- `diptych continue <crashed-detached-session>` cannot reach the documented resume path for a resumable not-running session.
- `diptych attach <dead-session>` exits 0 even though attach failed.

Fix:

- Make the crash diagnostic return a choice/status instead of exiting the process.
- Make attach print the diagnostic and then exit non-zero.
- Make continue print the diagnostic and then resume if `state.json` is resumable; otherwise exit non-zero.
- Add CLI tests for crashed detached attach and continue paths.

Why not duplicate:

- P1-60 covers stale active sessions after crashes.
- P1-56 covers detached startup cleanup.
- P1-79 covers workflow failure exit status.
- This finding is the crashed IPC-status path in `continue` and `attach`.

### P1-89: summary-screen snapshot accept/reject commands lose the completed session

Evidence:

- `src/features/workflow/screen.tsx:100` through `src/features/workflow/screen.tsx:101` navigate to summary with `sessionId`.
- `src/engine/orchestrator/session-lifecycle.ts:54` clears the active pointer on final save unless it is preserved.
- `src/core/runtime/commands/registry.ts:393` through `src/core/runtime/commands/registry.ts:399` expose `/accept-run` on workflow and summary routes.
- `src/core/runtime/commands/registry.ts:408` and nearby lines expose `/reject-run` similarly.
- `src/app/command-context.ts:26` through `src/app/command-context.ts:31` include `currentSessionId(projectDir)`, which uses the workflow/summary route `sessionId` before falling back to the active pointer.
- `src/app/command-context.ts:122` through `src/app/command-context.ts:126` implement `acceptRunSnapshot` using `readActive(projectDir)` instead.
- `src/app/command-context.ts:128` through `src/app/command-context.ts:132` implement `rejectRunSnapshot` using `readActive(projectDir)` instead.

Impact:

- After normal completion, a user on the summary screen can be unable to `/reject-run confirm` rollback or `/accept-run` because the active pointer has already been cleared.
- Generated changes that the user wanted to reject can remain in the working tree.

Fix:

- Resolve accept/reject snapshot commands through the current route session ID, matching the `currentSessionId()` pattern.
- Fall back to the active pointer only when the route has no session.
- Add a summary-screen completion test for both commands.

Why not duplicate:

- P1-44 covers `/handoff` losing the summary session.
- P1-62 and P1-78 cover snapshot config/coverage gaps.
- This finding affects rollback/accept safety from the completed summary screen.

### P1-90: E2E cassette replay does not validate provider request contracts

Evidence:

- `testing/e2e/helpers/e2e-harness.ts:71` through `testing/e2e/helpers/e2e-harness.ts:77` install the cassette recorder in record mode and the replayer otherwise.
- `testing/helpers/cassette/replayer.ts:35` through `testing/helpers/cassette/replayer.ts:46` compare only request method and URL path before returning a canned response.
- `testing/helpers/cassette/recorder.ts:44` through `testing/helpers/cassette/recorder.ts:52` record request method, URL, headers, and body.
- Existing cassettes such as `testing/e2e/cassettes/quick-add-endpoint.json` include request metadata that replay currently does not enforce.

Impact:

- Provider payload regressions can ship with green E2E tests.
- Wrong model, missing `stream`, malformed Anthropic/OpenAI JSON bodies, wrong auth/header behavior, wrong host with the same path, or dropped prompt/context fields can still replay successfully.
- Cassette tests prove call count/order and generated artifacts, not valid provider request contracts.

Fix:

- In replay mode, match a canonical request contract: method, full URL/base host, query, provider-critical headers, and canonical JSON body.
- Support explicit redaction and ignore rules for secrets and unstable fields.
- Fail replay on body/header/host mismatch.
- Re-record cassettes with safe canonical request bodies.

Why not duplicate:

- P1-31 covers E2E tests not being a release gate and bypassing CLI entrypoints.
- This finding applies even when E2E tests do run: replay masks broken provider requests.

### P1-91: `approval.tiers.validation` is documented but not enforced for actual validation commands

Evidence:

- `docs/APPROVAL-AND-RECOVERY.md:43` through `docs/APPROVAL-AND-RECOVERY.md:50` document a `validation` action class with default `auto`.
- `docs/CONFIGURATION.md:759` through `docs/CONFIGURATION.md:766` document `approval.tiers.validation`.
- `src/engine/orchestrator/approval/action-classifier.ts:20` through `src/engine/orchestrator/approval/action-classifier.ts:23` include `validation` in the default tier map.
- `src/engine/orchestrator/approval/action-classifier.ts:252` through `src/engine/orchestrator/approval/action-classifier.ts:254` classify validation command patterns.
- `src/engine/orchestrator/task/step.ts:209` calls `wctx.validator.runValidation(...)` directly with no `gateAction`.
- `src/engine/orchestrator/validation.ts:58` through `src/engine/orchestrator/validation.ts:64` resolve validation commands from config, discovery, and heuristics.
- `src/engine/orchestrator/validation.ts:176` executes validation via `runCommand(cmd, args, { cwd })`.
- `src/lib/process/spawn.ts:46` through `src/lib/process/spawn.ts:49` spawn with inherited environment by default.

Impact:

- A user setting `approval.tiers.validation: sticky` or `confirm` still gets unprompted `npm test`, `tsc`, configured validation, or heuristic validation commands.
- Those commands run with inherited environment, including API keys and local secrets.

Fix:

- Gate every resolved validation command before execution.
- Fail closed in headless mode when validation approval is required.
- Run validation with a minimal or allowlisted environment unless the user explicitly opts into inherited env.
- Add tests for config, discovered, and heuristic validation under `sticky` and `confirm`.

Why not duplicate:

- P0-14 covers planner-discovered validation commands.
- This finding is broader: the documented validation approval tier is inert for all validation sources, including defaults and project config.

### P1-92: project config can trigger Git mutations outside approval and commit/stash unrelated dirty files

Evidence:

- `src/core/config/load/load.ts:107` through `src/core/config/load/load.ts:110` autoload `.diptych/config.yaml` when it exists.
- `src/core/schemas/config.ts:40` through `src/core/schemas/config.ts:43` allow Git side-effect config such as `commitStrategy` and `createBranch`.
- `src/engine/orchestrator/run/init.ts:148` through `src/engine/orchestrator/run/init.ts:151` perform `workflow.git.createBranch` during workflow init.
- `src/engine/orchestrator/task/commit.ts:42` through `src/engine/orchestrator/task/commit.ts:69` implement config-driven per-task commits and call `gitOps.stageAll`.
- `src/engine/orchestrator/task/commit.ts:74` through `src/engine/orchestrator/task/commit.ts:80` implement config-driven checkpoint stashes.
- `src/lib/git.ts:54` through `src/lib/git.ts:56` implement `stageAll` as `git add .`.
- `src/lib/git.ts:121` through `src/lib/git.ts:123` make `createTaggedStash` call `stageAll`.
- `src/engine/orchestrator/task/apply-changed-files.ts:40` gates files changed since the task snapshot, not unrelated dirty files that existed before the task.

Impact:

- An untrusted cloned repository can opt the user into branch checkout, commits, or stashes through project config.
- Per-task commits and checkpoint stashes can include unrelated dirty work outside the task approval surface because `git add .` stages everything.

Fix:

- Require explicit trust/approval or CLI opt-in for config-driven Git mutations.
- Route branch, stage, commit, and stash operations through approval.
- Stage only approved task-changed files.
- Refuse or prompt when unrelated dirty files already exist.

Why not duplicate:

- P1-65 covers config downgrading approval policy.
- P1-66 covers runner permissions.
- This finding is Diptych's own Git mutation path and `git add .` crossing the approval boundary.

### P1-93: first-run `.gitignore` update follows symlinks and can append outside the project

Evidence:

- `src/core/config/load/load.ts:160` through `src/core/config/load/load.ts:168` call `ensureGitignore(projectDir, ".diptych/")` during `initConfig`.
- `src/cli/setup.ts:30` through `src/cli/setup.ts:33` can reach config init when config is missing.
- `src/cli/setup.ts:64` through `src/cli/setup.ts:67` run `initConfig(projectDir)` through the setup router with overrides.
- `src/cli/commands/init.ts:26` through `src/cli/commands/init.ts:27` call `initConfig`.
- `src/lib/fs.ts:83` through `src/lib/fs.ts:92` implement `ensureGitignore` using `existsSync`, `readFileSync`, `appendFileSync`, and `writeFileSync` on `<project>/.gitignore` with no `lstat`, realpath confinement, or no-follow protection.

Impact:

- A malicious repository can make `.gitignore` a symlink to a user-writable file outside the project.
- First run or `diptych init` can append `.diptych/` to that outside file, causing outside-project mutation or corruption.

Fix:

- `lstat` `.gitignore` before reading or writing.
- Reject symlinks and non-regular files.
- Verify realpath stays under the project.
- Safely create a new regular `.gitignore` only when absent.

Why not duplicate:

- P0-11 covers `writeSecureFile` symlinks under `.diptych`.
- P1-21 covers `.diptych` control-plane hardening.
- This finding is the root `.gitignore` mutation path outside `.diptych`.

### P2-25: detached heartbeat can race clean exit and erase `exitedAt`

Evidence:

- `src/engine/ipc/heartbeat.ts:4` through `src/engine/ipc/heartbeat.ts:7` fire-and-forget `updateHeartbeat(sessionDir)` on an interval.
- `src/engine/ipc/lockfile.ts:43` through `src/engine/ipc/lockfile.ts:47` update the lockfile with read-modify-write semantics.
- `src/engine/ipc/server-entry.ts:108` through `src/engine/ipc/server-entry.ts:112` call `stopHeartbeat()` and then `markExited(dir, exitCode)`, but do not await any in-flight heartbeat.

Impact:

- A heartbeat read that started before exit can write after `markExited` and remove `exitedAt`.
- A clean detached run can later look crashed or dead.

Fix:

- Serialize lockfile updates.
- Await any in-flight heartbeat update on shutdown.
- Make heartbeat writes preserve terminal fields.

Why not duplicate:

- P1-56, P1-74, and P1-79 cover detached/process shutdown failures.
- This finding is a clean-exit lockfile race.

### P2-26: non-workflow features import engine internals directly

Evidence:

- `src/features/runners/model-catalog.ts:8` through `src/features/runners/model-catalog.ts:9` import `../../engine/providers/model/catalog.js` and `../../engine/providers/model/resolution.js`.
- `src/features/runners/picker-view.tsx:6` imports `../../engine/detection/service.js`.
- `src/features/summary/screen.tsx:23` imports `../../engine/orchestrator/evidence/persistence.js`.

Impact:

- Runner and summary features depend on provider/orchestrator internals outside the documented workflow boundary.
- The engine becomes a UI service layer, increasing refactor blast radius and making the documented architecture less reliable.

Fix:

- Move pure model catalog and evidence-read contracts into `core` or store-facing adapters.
- Keep engine-only detection/orchestrator persistence behind workflow/init boundaries.

Why not duplicate:

- P2-12 covers worker packet preview drift.
- P2-13 covers runtime command context breadth.
- This finding is a non-workflow feature-to-engine dependency boundary issue.

### P2-27: production runtime import cycles

Evidence:

- `src/engine/orchestrator/evidence/review-packet/build.ts:27` through `src/engine/orchestrator/evidence/review-packet/build.ts:32` import builders from `sections.ts`.
- `src/engine/orchestrator/evidence/review-packet/sections.ts:24` imports `addMissing` and types back from `build.ts`.
- `src/components/pickers/two-column-picker/use-two-column-state.ts:4` imports `handleKeyboardInput` from `two-column-keyboard.ts`.
- `src/components/pickers/two-column-picker/two-column-keyboard.ts:3` imports `isVirtualCustomItem` and `RightItemOrVirtual` from `use-two-column-state.ts`.

Impact:

- ESM cycles create hidden bidirectional coupling in review-packet and shared picker code.
- Future refactors can turn these cycles into initialization-order runtime failures while typecheck still passes.

Fix:

- Move shared review-packet helpers/types into a leaf helper module.
- Move two-column picker shared types/helpers into a leaf types/helper module.
- Add an import-cycle check if the project already has or can cheaply adopt one.

Why not duplicate:

- Existing review-packet findings cover privacy and evidence retention.
- No prior baseline item covers production runtime import cycles.

### P2-28: `$EDITOR` values with arguments are documented but unsupported by both external edit paths

Evidence:

- `src/features/workflow/review-parser.ts:34` through `src/features/workflow/review-parser.ts:40` set `editor = process.env.EDITOR || "vi"` and then call `spawn(editor, [filePath])`.
- `src/features/workflow/components/plan-editor/external-editor.ts:20` through `src/features/workflow/components/plan-editor/external-editor.ts:23` set `editor = process.env.EDITOR ?? "vi"`.
- `src/features/workflow/components/plan-editor/external-editor.ts:43` through `src/features/workflow/components/plan-editor/external-editor.ts:47` call `spawnSync(editor, [tmpPath])`.
- `docs/TROUBLESHOOTING.md:841` through `docs/TROUBLESHOOTING.md:849` tell users they can set `EDITOR=vi`, `nano`, or `code --wait`.
- `docs/CONFIGURATION.md:922` documents `EDITOR` for the external editor.
- `docs/USAGE-EXAMPLES.md:133` and `docs/USAGE-EXAMPLES.md:571` advertise pressing `e` to open `$EDITOR`.
- `src/utils/parse-shell-command.ts` already exists and handles quoted/split command strings, but this helper is not used by these editor paths.
- Existing tests only stub `EDITOR` as a bare executable path, not as `code --wait` or another command with arguments.

Impact:

- Common settings such as `EDITOR="code --wait"`, `cursor --wait`, `vim -f`, or `nano -w` are treated as executable names containing spaces.
- Spec/brief review editing and rich plan editor editing can fail when the user follows the documentation.

Fix:

- Parse `EDITOR` into command plus args without invoking a shell.
- Append the temp file path after parsed editor args.
- Prefer `VISUAL` then `EDITOR` if that matches intended CLI behavior.
- Add tests for `code --wait`-style values in both review parser and plan editor paths.

Why not duplicate:

- P1-12 covers broad docs/package claims drift.
- This is a concrete broken review/plan-editor workflow and documentation example.

---

## Updated Final Baseline For Next Loop (After Eighth Loop)

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.
- Fourth-loop findings.
- Fifth-loop findings P0-16 and P1-48 through P1-58.
- Sixth-loop findings P1-59 through P1-69.
- Seventh-loop findings P1-70 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.

Any further audit agent must first read this whole file and exclude every finding listed here. The prompt to each agent should explicitly say that P0-1 through P0-16, P1-1 through P1-93, and P2-1 through P2-28 are already-known findings and must not be reported again. Because the eighth loop still found new P1/P2 issues, the audit is not done. Future loops must report only new, non-duplicate findings, or explicitly state no-new-P0/P1/P2 for that lane after checking against this file.

---

## Ninth Loop Findings - 2026-05-25

Scope:

- Ninth-loop agents were instructed to read this whole file through the "After Eighth Loop" baseline before auditing.
- The explicit exclusion set for this loop was P0-1 through P0-16, P1-1 through P1-93, and P2-1 through P2-28.
- The localhost/MCP/RPC/IPC lane reported no-new-P0/P1/P2 after checking the baseline.
- The packaging lane reported no new P0/P1 and two new P2 issues.
- A local IPC/RPC input-frame candidate was not added because P1-22 already covers unbounded IPC/RPC malformed input and raw echo behavior.
- No new P0 finding was reported in this loop.

### P1-94: validation runs project-wide checks once per task

Evidence:

- `src/core/config/load/load.ts:29` through `src/core/config/load/load.ts:34` enable typecheck, lint, and test by default.
- `src/engine/orchestrator/task/step.ts:209` calls `wctx.validator.runValidation(...)` for every task.
- `src/engine/orchestrator/validation.ts:95` through `src/engine/orchestrator/validation.ts:110` run typecheck and lint before task tests.
- `src/engine/orchestrator/validation.ts:117` through `src/engine/orchestrator/validation.ts:138` then run tests.

Impact:

- A 30-task workflow can run full-project typecheck and lint 30 times.
- Large repositories can spend most workflow wall time in repeated validation subprocesses even when one file changed.

Fix:

- Separate cheap per-task checks from full-project gates.
- Cache validation by changed-file set, command, config hash, and lockfile hash.
- Run full typecheck/lint at planned checkpoints or final review, not blindly after every task.

Why not duplicate:

- P1-34 covers validation skipping and false pass semantics.
- P1-91 covers validation approval not being enforced.
- This finding is the scaling cost of valid validation commands being repeated per task.

### P1-95: per-task changed-file snapshots read full dirty file contents repeatedly

Evidence:

- `src/engine/orchestrator/task/pre-task.ts:57` through `src/engine/orchestrator/task/pre-task.ts:60` capture a changed-file snapshot at every task start.
- `src/engine/orchestrator/approval/file-snapshots.ts:32` through `src/engine/orchestrator/approval/file-snapshots.ts:41` read every changed file into memory with unbounded `Promise.all`.
- `src/engine/orchestrator/approval/file-snapshots.ts:58` through `src/engine/orchestrator/approval/file-snapshots.ts:68` reread dirty files for comparison.
- `src/engine/orchestrator/task/apply-changed-files.ts:40` through `src/engine/orchestrator/task/apply-changed-files.ts:42` recompute changed files after implementation.
- `src/engine/orchestrator/task/step.ts:42` and `src/engine/orchestrator/task/step.ts:239` run drift-chain analysis by recomputing changed files from the same snapshot.

Impact:

- Repositories with many dirty/generated files pay repeated full-content reads per task.
- Successful tasks can do duplicate changed-file scans before validation/finalization.

Fix:

- Snapshot changed files with metadata/hash tails and bounded concurrency.
- Pass the already computed `taskChangedFiles` into drift-chain analysis.
- Preserve full file contents only when rollback actually requires them, with size caps.

Why not duplicate:

- P1-54 covers the separate user-edit conflict baseline in `changed-files-baseline.ts`.
- P1-46 covers direct-write temp project copies.
- This finding is the per-task approval/staging snapshot path plus duplicate post-task recomputation.

### P1-96: workflow state persistence rewrites full state synchronously on hot paths

Evidence:

- `src/engine/orchestrator/state-ops.ts:14` through `src/engine/orchestrator/state-ops.ts:23` save full state after every transition.
- `src/engine/orchestrator/state-ops.ts:52` through `src/engine/orchestrator/state-ops.ts:59` save full state after usage updates.
- `src/core/state/persistence.ts:15` through `src/core/state/persistence.ts:17` stringify and write the whole `state.json`.
- `src/lib/fs.ts:42` through `src/lib/fs.ts:45` use synchronous file writes/chmod.
- `src/core/state/machine.ts:109` through `src/core/state/machine.ts:113` and `src/core/state/machine.ts:241` through `src/core/state/machine.ts:245` copy the task array on common transitions.

Impact:

- Long workflows with many tasks make each transition and cost update proportional to full state size.
- Large task lists, `currentCode`, or queued messages create repeated event-loop stalls and disk churn.

Fix:

- Batch/debounce state checkpoints.
- Store compact mutable runtime state separately from append-only events.
- Avoid pretty JSON on hot paths.
- Write atomically through a background queue.

Why not duplicate:

- P1-7 covers synchronous JSONL event persistence.
- P1-26 covers `currentCode` privacy in `state.json`.
- P2-7 covers drained queue retention.
- This finding is full-state synchronous checkpoint cost across normal workflow transitions.

### P1-97: evidence ledger persistence is O(tasks) per update and rewrites the whole ledger

Evidence:

- `src/engine/orchestrator/evidence/persistence.ts:23` through `src/engine/orchestrator/evidence/persistence.ts:24` write the entire evidence ledger.
- `src/engine/orchestrator/evidence/persistence.ts:34` through `src/engine/orchestrator/evidence/persistence.ts:37` read or create the full ledger on each persistence call.
- `src/engine/orchestrator/evidence/persistence.ts:57` through `src/engine/orchestrator/evidence/persistence.ts:67` hash all tasks, update one task, then rewrite the whole ledger.
- `src/engine/orchestrator/evidence/ledger.ts:55` through `src/engine/orchestrator/evidence/ledger.ts:63` map all ledger tasks and recompute validation summary.
- `src/engine/mcp/tool/operations.ts:122` through `src/engine/mcp/tool/operations.ts:144` make MCP progress/evidence handlers rewrite the ledger too.

Impact:

- Many tasks, retries, approvals, or MCP progress updates cause repeated full JSON parse/stringify/write cycles.
- This can stall the workflow and makes chatty MCP evidence reporting scale poorly.

Fix:

- Use append-only evidence events or per-task evidence files.
- Maintain a compact summary index.
- Batch MCP progress/evidence writes and recompute summaries incrementally.

Why not duplicate:

- P1-50 and P1-73 cover evidence privacy/leakage.
- P1-87 covers session tree recorder scalability.
- This finding is the evidence ledger's own write-amplification path.

### P1-98: validation command timeouts can still be recorded as passing

Evidence:

- `src/lib/process/spawn.ts:105` through `src/lib/process/spawn.ts:109` define `runCommand()` without a `timedOut` result.
- `src/lib/process/spawn.ts:119` through `src/lib/process/spawn.ts:120` only start a timer that calls `killProcess(proc)`.
- `src/lib/process/registry.ts:21` through `src/lib/process/registry.ts:36` send `SIGTERM` first.
- `src/engine/orchestrator/validation.ts:176` receives only `{ stdout, stderr, code }`.
- `src/engine/orchestrator/validation.ts:182` marks validation passed when `code === 0`.

Impact:

- A validation script can trap `SIGTERM` and exit `0` when Diptych's timeout fires.
- Diptych then treats the timed-out validation as successful, so a hung or hostile test/lint/typecheck command can bypass the validation gate.

Fix:

- Make `runCommand()` return or throw a timeout-specific result.
- Validation must fail closed on timeout regardless of child exit code.
- Add a regression test with a validation script that traps `SIGTERM` and exits `0`.

Why not duplicate:

- P1-57 covers process-tree cleanup after timeout.
- P1-34 covers skipped/missing validation.
- This finding is different: timeout outcome is lost and can be converted into a validation pass.

### P1-99: validation subprocesses ignore workflow abort signals

Evidence:

- `src/features/workflow/hooks/use-workflow-runner.ts:149` through `src/features/workflow/hooks/use-workflow-runner.ts:158` pass an `AbortSignal` into `runWorkflow()`.
- `src/cli/rpc/run.ts:243` through `src/cli/rpc/run.ts:262` also pass the RPC abort signal into `runWorkflow()`.
- `src/engine/orchestrator/types.ts:59` stores `signal` on `WorkflowContext`.
- `src/engine/orchestrator/task/step.ts:194` checks the signal before validation.
- `src/engine/orchestrator/task/step.ts:209` then calls `wctx.validator.runValidation(...)` without passing the signal.
- `src/engine/orchestrator/validation.ts:27` through `src/engine/orchestrator/validation.ts:35` define `runValidation()` with no signal parameter.
- `src/lib/process/spawn.ts:105` through `src/lib/process/spawn.ts:109` define `runCommand()` with no signal option.

Impact:

- TUI cancel or RPC abort can be accepted while `npm test`, `tsc`, lint, or configured validation continues until completion or timeout.
- This is especially bad for long test suites and validation commands with inherited secrets.

Fix:

- Thread `AbortSignal` through `Validator.runValidation()`, `runValidationStep()`, and `runCommand()`.
- Abort should kill the process group and return a clear aborted validation result.

Why not duplicate:

- P1-38 covers planner abort propagation.
- P1-67 covers implementer cancel/timeout gaps.
- P1-76 covers RPC gates.
- P1-91 covers validation approval.
- This finding covers validation subprocesses ignoring the workflow abort signal.

### P1-100: `pre_commit` / `block-secrets` is not a reliable blocking safety gate

Evidence:

- `docs/CONFIGURATION.md:641` describes `block-secrets` as rejecting commits/diffs in `pre_commit`.
- `src/engine/hooks/builtins/registry.ts:14` through `src/engine/hooks/builtins/registry.ts:17` wire `block-secrets` only to `pre_commit`.
- `src/engine/hooks/builtins/block-secrets.ts:13` through `src/engine/hooks/builtins/block-secrets.ts:19` scan only `event.file`.
- `src/engine/orchestrator/task/commit.ts:47` through `src/engine/orchestrator/task/commit.ts:51` send only `task.file` in the `pre_commit` payload.
- `src/engine/orchestrator/task/commit.ts:67` through `src/engine/orchestrator/task/commit.ts:69` stage and commit via `stageAll()`.
- `src/engine/orchestrator/task/commit.ts:51` through `src/engine/orchestrator/task/commit.ts:63` treat a blocking `pre_commit` hook as a warning, then still transition the task complete.
- `src/engine/orchestrator/task/commit.test.ts:321` through `src/engine/orchestrator/task/commit.test.ts:336` lock in `result.completed === true` and `task_completed` after `block-secrets` denies.

Impact:

- With `block-secrets` enabled, secrets in changed files other than `task.file` are not scanned before `git add .`.
- Even when a secret is detected in `task.file`, the workflow records the task as completed and continues, leaving the secret-bearing working tree accepted as successful.

Fix:

- Run secret/blocking checks over the actual changed or staged file set.
- A deny from a security hook should fail the task, pause for recovery, or require explicit user override.
- If this remains non-fatal, rename/document it as a commit-only warning, not a blocking safety control.

Why not duplicate:

- P2-18 covers `block-secrets` reading outside the project.
- P1-92 covers config-driven `git add .` side effects.
- P0-4 and P1-71 cover hook trust.
- This finding is the separate safety semantics: the secret hook scans too little and denial does not block task acceptance.

### P1-101: approval-denied task leaves a resumable session but clears the active pointer

Evidence:

- `src/engine/orchestrator/task/step.ts:103` marks the task `in_progress`.
- `src/engine/orchestrator/task/step.ts:127` through `src/engine/orchestrator/task/step.ts:129` record approval denial and return without pending recovery or terminal task state.
- `src/engine/orchestrator/task/step.ts:161` through `src/engine/orchestrator/task/step.ts:165` do the same for pre-apply approval denial.
- `src/engine/orchestrator/task/apply-changed-files.ts:70` through `src/engine/orchestrator/task/apply-changed-files.ts:98` return `proceed: false` after changed-file approval denial.
- `src/engine/orchestrator/task/loop.ts:167` through `src/engine/orchestrator/task/loop.ts:170` convert the non-advanced task index into `status: "stopped"`.
- `src/engine/orchestrator/run/run.ts:26` through `src/engine/orchestrator/run/run.ts:28` preserve active only for `pendingRecovery` or rewind aborts.
- `src/engine/orchestrator/session-lifecycle.ts:54` clears active when not preserved.
- `src/cli/commands/resume.ts:31` through `src/cli/commands/resume.ts:33` require the active pointer.

Impact:

- A user who denies an unsafe task/write, or hits headless `APPROVAL_REQUIRED`, gets an interrupted/resumable `implementing` state with the task still `in_progress`, but no pending recovery and no default `diptych resume` path.
- Recovery depends on knowing the session ID and using explicit `continue <id>`.

Fix:

- On task-action, pre-apply, and changed-file approval denial, either create a structured `pendingRecovery` issue and preserve active, or transition the task/session to an explicit terminal aborted state.
- Add behavior tests through `runWorkflow`/CLI for TUI denial, headless approval-required, and changed-file denial.

Why not duplicate:

- P1-65 covers config downgrading approval policy.
- P1-79 covers failed workflow exit status.
- P1-91 covers validation approval.
- P1-61 covers explicit continue ownership.
- P1-48 covers approval command coverage.
- This finding is the state-machine/final-session bug where approval denial produces a resumable-looking session but finalization clears active because no recovery object exists.

### P1-102: RPC `status` emits the full workflow state to stdout

Evidence:

- `src/cli/rpc/dispatch.ts:96` through `src/cli/rpc/dispatch.ts:98` dispatch `status` to `deps.writeStatus()`.
- `src/cli/rpc/run.ts:108` through `src/cli/rpc/run.ts:118` load state and include `state` verbatim in the status payload.
- `src/cli/rpc/writer.ts:16` through `src/cli/rpc/writer.ts:17` write status as JSON.
- `src/core/schemas/workflow.ts:30` through `src/core/schemas/workflow.ts:46` include `feature`, `tasks`, `messageQueue`, and related workflow fields in persisted state.
- `src/core/schemas/task.ts:37` through `src/core/schemas/task.ts:46` include task descriptions, tests, constraints, and optional `currentCode`.

Impact:

- Any RPC client or stdout logger can receive full source snapshots, queued user text, clarification answers, recovery details, and task briefs just by asking for status.

Fix:

- Return a sanitized status DTO only: phase, session ID, counts, pending gate type, queue depth, current task ID/title.
- Put full state behind an explicit debug/unsafe command with redaction and size caps.

Why not duplicate:

- P1-25 covers JSONL/headless event persistence.
- P1-26 covers durable `state.json`.
- P1-22 covers malformed RPC input echoing.
- This finding is a separate on-demand RPC stdout exfiltration surface.

### P1-103: approval/rejection reasons persist into evidence, and rejection reasons are re-sent to the planner

Evidence:

- `src/engine/orchestrator/approval/tiered-approval.ts:137` through `src/engine/orchestrator/approval/tiered-approval.ts:143` carry freeform approval/rejection reasons.
- `src/engine/orchestrator/evidence/approval-evidence.ts:28` through `src/engine/orchestrator/evidence/approval-evidence.ts:48` copy `actionDescription` and `reason` into ledger entries.
- `src/engine/orchestrator/evidence/persistence.ts:83` through `src/engine/orchestrator/evidence/persistence.ts:103` write those entries to `evidence.json`.
- `src/engine/orchestrator/evidence/reporting.ts:33` through `src/engine/orchestrator/evidence/reporting.ts:39` build rejection prompt text.
- `src/engine/orchestrator/planning/shared.ts:110` through `src/engine/orchestrator/planning/shared.ts:117` prepend that text to the planner prompt by default.

Impact:

- A user's approval/rejection reason can contain sensitive operational context, credentials, paths, or incident details.
- That text is retained in evidence/review artifacts, and rejection text can leave the local boundary via the next planner call.

Fix:

- Store structured reason codes plus short redacted/capped notes.
- Do not feed raw rejection text to planners by default.
- Pass only sanitized action class/task context unless the user opts in.

Why not duplicate:

- P1-25 covers approval text in event/session-log sinks.
- P1-50 covers validation evidence.
- P1-73 covers MCP evidence text.
- This finding is the approval evidence ledger plus planner re-prompting path.

### P2-29: runtime imports undeclared Shiki subpackages

Evidence:

- `src/lib/highlight.ts:25` through `src/lib/highlight.ts:26` dynamically import `@shikijs/themes/github-dark` and `@shikijs/themes/github-light`.
- `src/lib/highlight.ts:29` through `src/lib/highlight.ts:30` dynamically import `@shikijs/langs/typescript` and `@shikijs/langs/javascript`.
- `package.json:52` through `package.json:72` declare runtime dependencies, but list only `shiki` at `package.json:66`, not `@shikijs/langs` or `@shikijs/themes`.
- `package-lock.json` currently contains `@shikijs/langs` and `@shikijs/themes` only through Shiki's transitive dependency tree.

Impact:

- The installed CLI relies on Shiki's transitive dependency layout.
- A compatible `shiki` update or package graph change can make syntax highlighting imports fail in global installs even though Diptych's own dependency metadata looks valid.

Fix:

- Declare `@shikijs/langs` and `@shikijs/themes` as direct runtime dependencies at the tested version, or switch imports to Shiki public subpaths if those are the intended stable API.
- Add a dependency-check gate that production imports resolve from declared runtime deps.

Why not duplicate:

- P1-70 covers unreproducible global dependency graphs from ranged dependencies.
- This finding is a separate package metadata issue: Diptych directly imports packages it does not directly declare.

### P2-30: CLI version is duplicated instead of sourced from package metadata

Evidence:

- `package.json:3` declares version `0.1.0`.
- `src/cli.ts:34` through `src/cli.ts:37` hard-code `.version("0.1.0")`.
- `src/core/paths-io.ts:18` through `src/core/paths-io.ts:31` already provide a package-version reader used elsewhere.

Impact:

- A release can bump `package.json` while shipping a `diptych --version` that reports the old version.
- This weakens install verification, support debugging, and npm/global CLI release confidence.

Fix:

- Use one version source of truth for CLI metadata.
- Add a package smoke assertion that installed `diptych --version` equals the packed package version.

Why not duplicate:

- P0-3 covers the built/package CLI path not being smoke-tested.
- P1-77 covers missing repo-level CI/release workflow.
- This finding is the concrete version source-of-truth drift risk inside CLI metadata.

### P2-31: routing and cost estimation rebuild full task prompts per task/profile

Evidence:

- `src/engine/orchestrator/budget/estimate.ts:227` through `src/engine/orchestrator/budget/estimate.ts:243` estimate every task.
- `src/engine/orchestrator/budget/estimate.ts:118` through `src/engine/orchestrator/budget/estimate.ts:125` route each task through implementer profiles.
- `src/engine/orchestrator/context-routing/route.ts:5` through `src/engine/orchestrator/context-routing/route.ts:9` assess every profile.
- `src/engine/orchestrator/context-routing/assessment.ts:37` through `src/engine/orchestrator/context-routing/assessment.ts:39` format/estimate an untruncated prompt and then format/estimate another bounded prompt.
- `src/engine/spec/prompt-formatter.ts:155` through `src/engine/spec/prompt-formatter.ts:175` build full prompt strings, including current-code insertion for modify tasks.

Impact:

- Cost prediction and routing do repeated large string construction for `tasks x profiles`.
- The same work is repeated later during task execution routing.

Fix:

- Build one reusable task prompt packet per task and cache profile-specific estimates.
- Estimate token counts from sections/lengths without materializing full strings repeatedly.
- Reuse the selected routing decision through dispatch when inputs have not changed.

Why not duplicate:

- P2-12 covers packet construction/preview drift as an architecture issue.
- This finding is the concrete allocation and CPU cost of repeated prompt materialization.

### P2-32: error factory pattern is bypassed by bare `new Error` construction

Evidence:

- `docs/ERRORS.md:3` says the error pattern applies everywhere.
- `docs/ERRORS.md:13` says errors should be factory-built and carry discriminator/data.
- `docs/ERRORS.md:300` marks bare `throw new Error(...)` without a domain bag as an anti-pattern.
- `src/lib/process/spawn.ts:66` uses `fail(new Error("Process streams not available"))`.
- `src/engine/runners/factory.ts:28` returns a bare `new Error(...)`.
- `src/engine/ipc/server.ts:312` rejects with `new Error(...)`.
- `src/engine/ipc/server.ts:357` rejects pending prompts with a bare `new Error(...)`.
- `src/engine/hooks/dispatch.ts:71` rejects hook timeout with `new Error(...)`.
- `src/engine/orchestrator/planning/instant.ts:72` and `src/engine/orchestrator/planning/instant.ts:88` pass bare errors into planning failure handling.
- `src/engine/orchestrator/planning/quick.ts:51` does the same for brief quality gate failure.

Impact:

- These errors cannot be narrowed by `kind`, do not carry stable structured `data`, and make recovery/formatting behavior depend on message text.
- This weakens the documented error contract and makes future handling of IPC, hook, planner, and process failures more brittle.

Fix:

- Add small domain error bags where these errors originate, such as `processError.streamUnavailable`, `runnerError.agentSdkMissing`, `ipcError.bindFailed`, `hookError.timeout`, and `planningError.emptyPlan/briefQualityFailed`.
- Keep `cliError()` as the documented CLI exception.
- Expand the invariant check to catch bare `new Error(` outside allowed factory files, not only literal `throw new Error`.

Why not duplicate:

- P1-9 and P1-10 cover invariant gates not being complete or wired into CI.
- P2-1 covers unsafe TypeScript assertions.
- This finding is current production code violating the documented error-domain contract.

### P2-33: tree navigation TUI and reconstruction helpers are production code but unwired

Evidence:

- `docs/FEATURES.md:657` through `docs/FEATURES.md:670` document a "Tree navigation TUI" as a user-facing feature.
- `docs/STRUCTURE.md:453` through `docs/STRUCTURE.md:455` list `tree-view` as a feature with an entry file imported by `src/app.tsx` or overlay layout.
- `src/features/tree-view/tree-view.tsx:21` exports `TreeView`.
- `src/core/navigation/types.ts:1` through `src/core/navigation/types.ts:16` define screens and overlays without any tree-view route/overlay.
- `src/app.tsx:70` through `src/app.tsx:107` render only the four screens.
- `src/app.tsx:117` through `src/app.tsx:148` render overlays without tree-view.
- `src/core/sessions/tree/reconstruct.ts:28`, `src/core/sessions/tree/reconstruct.ts:75`, and `src/core/sessions/tree/reconstruct.ts:85` export reconstruction helpers that are only used by tests/spec docs, not production code.

Impact:

- Customers cannot reach a documented feature.
- Tests can stay green while the feature remains dead/unshipped.
- The code increases maintenance surface around session-tree data without proving an actual runtime workflow.

Fix:

- Either wire tree-view into navigation/commands/palette/session summary with a real route and behavior tests, or remove/demote the unused feature and reconstruction helpers until there is a product path.
- If kept, add a production integration test proving a user can open the tree view from a real screen/command.

Why not duplicate:

- P1-87 covers session tree recorder performance.
- P2-20 covers session tree file modes.
- P2-27 covers import cycles in tree summary code.
- P1-12 covers broad docs/package claim drift.
- This finding is a concrete unwired production feature plus dead helpers.

### P2-34: malformed `.diptych/active` is not self-healed and can block recovery commands

Evidence:

- `src/core/sessions/lifecycle.ts:10` through `src/core/sessions/lifecycle.ts:14` return raw active-file contents without validating the session ID.
- `src/core/sessions/lifecycle.ts:16` through `src/core/sessions/lifecycle.ts:18` validate only writes.
- `src/core/sessions/guards.ts:4` through `src/core/sessions/guards.ts:12` pass the raw value to `isSessionLive`.
- `src/core/sessions/lifecycle.ts:26` through `src/core/sessions/lifecycle.ts:28` call `sessionDir`, and `src/core/paths.ts:32` through `src/core/paths.ts:34` validate and throw on invalid IDs.
- `src/cli/commands/start.ts:91` through `src/cli/commands/start.ts:99` only normalize `session-still-active`; other active-pointer errors bubble.
- `src/cli/commands/resume.ts:31` through `src/cli/commands/resume.ts:36` read active then load state through the same validating path.

Impact:

- A partial write, crash, or manual edit of `.diptych/active` to an invalid ID can make `start`, `resume`, and active-session commands fail with a low-level invalid-ID error instead of clearing or diagnosing the stale pointer.

Fix:

- Validate active IDs in `readActive` or `clearStaleSession`.
- Treat malformed active pointers as corrupt control-plane state with a clear diagnostic and safe cleanup path.
- Add tests for malformed active contents, separate from corrupt `state.json`.

Why not duplicate:

- P1-60 covers a valid active pointer to a stale live-looking session after crash.
- This finding is a different failure mode: invalid active-file contents throw before stale-session cleanup can run.

### P2-35: `diptych spec` has no behavior-level command coverage

Evidence:

- `docs/CLI-REFERENCE.md:171` through `docs/CLI-REFERENCE.md:180` document `diptych spec`.
- `docs/CLI-REFERENCE.md:203` through `docs/CLI-REFERENCE.md:206` say exit `0` means `spec.md`, `plan.md`, and `tasks.md` were all written.
- `src/cli/commands/spec.ts:17` through `src/cli/commands/spec.ts:24` register the public command without the repo's command DI pattern.
- `src/cli/commands/spec.ts:25` through `src/cli/commands/spec.ts:42` hard-wire setup/session/trust/planner creation.
- `src/cli/commands/spec.ts:62` through `src/cli/commands/spec.ts:71` write `result.phases ?? []` and then print success paths/task count.
- `docs/TESTING.md:210` through `docs/TESTING.md:213` say CLI command handlers should accept optional deps for behavior tests.
- Targeted search found no `src/cli/commands/spec.test.ts` and no integration `runCommand(["spec", ...])`; the only test-side `spec` command mention is a dummy subcommand in `src/cli/commands/start.test.ts:489`.

Impact:

- A regression in `--auto`, hook-trust refusal, planner failure handling, active-session creation, artifact persistence, or success output for the documented `diptych spec` path can ship without a failing test.

Fix:

- Add `SpecDeps` injection for setup/trust/session/planner/output.
- Add command-level behavior tests with a fake planner asserting exit code, stdout shape, `.diptych/active`, and exact `spec.md`/`plan.md`/`tasks.md` files.
- Include failure tests for planner error and hook distrust.

Why not duplicate:

- P0-3 covers packaged `dist`/installed-bin smoke and command-registration drift.
- P1-31 covers E2E not gating real CLI entrypoints.
- P1-77 covers missing repo-level CI/release workflow.
- This finding is a distinct untested public command handler and artifact-success contract inside the source-level command test strategy.

### P2-36: detached runs persist custom runner command overrides in `server-args.json`

Evidence:

- `src/cli/options.ts:11` and `src/cli/options.ts:14` expose `--planner-command` and `--implementer-command`.
- `src/cli/build-overrides.ts:5` through `src/cli/build-overrides.ts:15` copy command strings into CLI overrides.
- `src/cli/commands/start.ts:157` through `src/cli/commands/start.ts:167` pass overrides into detached server startup.
- `src/engine/ipc/spawn-server.ts:96` through `src/engine/ipc/spawn-server.ts:103` include overrides in server args.
- `src/engine/ipc/server-args.ts:127` through `src/engine/ipc/server-args.ts:129` write the artifact.

Impact:

- Command override strings often carry inline env assignments or flags such as API keys, bearer tokens, base URLs with credentials, or proxy credentials.
- Detached mode turns those ephemeral CLI strings into durable `.diptych/sessions/<id>/server-args.json` content.

Fix:

- Avoid persisting raw command overrides.
- Pass them through a one-time secure channel and delete the args file after server startup, or redact/cap command strings in the persisted artifact.

Why not duplicate:

- P1-47 covers prompt leakage through backend argv.
- P1-52 only notes `server-args` for lost image attachments.
- This finding is detached IPC argument retention of custom runner command secrets.

---

## Updated Final Baseline For Next Loop (After Ninth Loop)

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.
- Fourth-loop findings.
- Fifth-loop findings P0-16 and P1-48 through P1-58.
- Sixth-loop findings P1-59 through P1-69.
- Seventh-loop findings P1-70 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.
- Ninth-loop findings P1-94 through P1-103 and P2-29 through P2-36.

Any further audit agent must first read this whole file and exclude every finding listed here. The prompt to each agent should explicitly say that P0-1 through P0-16, P1-1 through P1-103, and P2-1 through P2-36 are already-known findings and must not be reported again. Because the ninth loop still found new P1/P2 issues, the audit is not done. Future loops must report only new, non-duplicate findings, or explicitly state no-new-P0/P1/P2 for that lane after checking against this file.

---

## Tenth Loop Findings - 2026-05-25

Scope:

- Tenth-loop agents were instructed to read this audit file through the ninth-loop baseline before reporting.
- Explicit exclusion set: P0-1 through P0-16, P1-1 through P1-103, and P2-1 through P2-36.
- Lanes covered localhost/IPC/RPC/MCP hardening, npm packaging/installable CLI readiness, secrets/privacy/telemetry/retention, child-process/sandbox/config trust, performance/scalability, behavior tests/release gates, clean-code/architecture, workflow state/session/recovery, plus a local abort-safety sweep.
- The npm packaging/installable CLI lane reported no-new-P0/P1/P2.
- No new P0 was found in this loop.

### P1-104: API stream abort can apply partial extracted code

Evidence:

- `src/engine/providers/openai-stream.ts:117` breaks the stream loop when `opts.signal?.aborted`, and `src/engine/providers/openai-stream.ts:128` returns `{ text: fullResponse, usage }` on abort instead of throwing.
- `src/engine/providers/anthropic/stream.ts:144` breaks the stream read loop on abort, and `src/engine/providers/anthropic/stream.ts:313` returns `{ text: fullResponse, usage }` when aborted.
- `src/engine/orchestrator/continuation.ts:64` installs `setAbortHandler(() => callController.abort())`.
- `src/engine/orchestrator/task/run-implementation.ts:96` only asks continuation to retry when `!result.success`.
- `src/engine/implementers/base.ts:181` passes returned text to `processImplementerOutput`, and `src/engine/implementers/base.ts:74` applies extracted code with `applyCode`.
- `src/engine/orchestrator/task/step.ts:194` checks `wctx.signal?.aborted` only after implementation/apply has returned.

Impact:

- Ctrl-C or abort-turn during API implementer streaming can stop the stream, treat partial output as successful, and apply any fenced partial code before validation.
- User intent to abort a turn can still produce unreviewed working-tree changes.

Fix:

- Make API stream abort throw or return an explicit aborted result, not a successful `InvokeResult`.
- In `createImplementerBase`, fail closed if `opts.signal.aborted` immediately after invoke returns, before extraction/apply.
- Add a behavior test where an API stream yields a code fence and then aborts, asserting no file write and the expected continuation/retry path.

Why not duplicate:

- P1-67 covers write-capable implementers outliving cancel/timeout.
- P1-38 covers planner abort propagation, and P1-99 covers validation abort.
- This is the opposite failure mode: API implementers do observe abort, but convert it into a successful partial result that can write code.

### P1-105: MCP serves raw `state.json` as a normal HTTP resource

Evidence:

- `src/engine/mcp/resolver.ts:197` advertises `STATE_FILE` as `state.json` / `Workflow state`.
- `src/engine/mcp/resolver.ts:312` through `src/engine/mcp/resolver.ts:313` reads and returns raw `STATE_FILE`.
- `src/core/schemas/workflow.ts` defines state fields that include workflow text, queues, clarifications, tasks, pending recovery, and planner session metadata.
- `src/core/schemas/task.ts` allows task descriptions and `currentCode`.
- `docs/FEATURES.md:499` and `docs/CLI-REFERENCE.md:1208` document `state.json` as an exposed MCP resource.

Impact:

- Any bearer-authorized MCP client can fetch raw internal resume state over localhost HTTP, including queued user text, clarification answers, recovery details, task briefs, copied source snapshots, and planner session handles.

Fix:

- Stop advertising or serving raw `state.json` by default.
- Expose a sanitized status/progress DTO instead.
- Put raw state behind an explicit debug/unsafe flag with redaction and length caps for `currentCode`, `messageQueue`, clarifications, recovery text, and session IDs.

Why not duplicate:

- P1-26 covers local persistence of `currentCode` in `state.json`.
- P1-102 covers RPC status stdout exfiltration.
- P1-82 covers symlinked MCP artifact reads.
- This is normal-path MCP HTTP exposure of a legitimate raw workflow-state resource.

### P1-106: native planner resume can retain prompts/source outside Diptych retention controls

Evidence:

- `docs/GETTING-STARTED.md:257` says there is no cloud-side state and everything lives under `.diptych/`.
- `docs/CONFIGURATION.md:455` scopes `persistTranscript` to planner/user text chunks in `session.jsonl`.
- `docs/HOW-IT-WORKS.md:223` says native session resume passes session IDs to backends and the prior conversation survives.
- `src/engine/claude-invoke.ts:125` passes Claude `--session-id`.
- `src/engine/cli-tools.ts:44` through `src/engine/cli-tools.ts:47` use `codex exec resume`.
- `src/engine/agent-sdk-backend.ts:186` sets `options.resume`.
- `src/engine/orchestrator/planning/shared.ts:128` persists planner session IDs into workflow state via `SET_PLANNER_SESSION_ID`.

Impact:

- Users can disable Diptych transcript persistence, but Claude Code, Codex, and Agent SDK planners can still retain and resume prior prompt/source/diff/user-turn context in backend or runner state outside `.diptych` and outside Diptych cleanup/retention controls.
- `plannerSessionId` in `state.json` becomes a durable handle to sensitive external conversation state.

Fix:

- Document backend-native session retention separately from `persistTranscript`.
- Add a privacy/stateless option that disables native resume and skips saving `plannerSessionId`, especially when `persistTranscript: false`.
- In stateless/privacy mode avoid `--session-id`, `codex exec resume`, and `options.resume`; add behavior tests for those contracts.

Why not duplicate:

- P1-25 and P1-26 cover Diptych JSONL/state persistence.
- P1-47 covers argv prompt exposure.
- P1-68 covers replaying Diptych persisted transcript.
- This is runner-managed session/transcript retention outside Diptych artifacts.

### P1-107: OS SIGINT/SIGTERM cleanup does not abort the workflow

Evidence:

- `src/engine/orchestrator/signals.ts:8` through `src/engine/orchestrator/signals.ts:11` only records that a signal arrived and starts the cleanup handler.
- `src/engine/orchestrator/signals.ts:16` awaits the wrapped workflow body to completion before returning `{ cancelled }`.
- `src/engine/orchestrator/run/run.ts:61` wraps the workflow in shutdown handlers, but the body keeps running after the signal unless some separate abort signal is already observed.
- `src/engine/orchestrator/run/run.ts:119` only uses `cancelled` when no result was produced; if the workflow later produces a result, `src/engine/orchestrator/run/run.ts:132` saves that result.
- `src/engine/orchestrator/final-review.ts:144` cleanup kills currently registered processes, but it does not stop future retries, validation, escalation, or finalization from starting.

Impact:

- In foreground/headless process-signal paths, Ctrl-C or SIGTERM can kill current children once, while the workflow continues into later stages and spawns new work after the user tried to stop it.

Fix:

- Make `runWorkflow` own or receive an abort controller for process signals.
- Abort it inside `withSignalHandlers`.
- Treat `cancelled` as terminal even if the workflow later produces a result.
- Add a signal test proving no retry, validation, escalation, or final review starts after SIGINT.

Why not duplicate:

- P1-38, P1-67, and P1-99 cover missing propagation of an already-aborted signal into planner, implementer, or validation backends.
- This is earlier: OS signals do not create a workflow abort at all.

### P1-108: detached IPC server signal cleanup exits without killing active runner children

Evidence:

- `src/engine/ipc/server-entry.ts:108` through `src/engine/ipc/server-entry.ts:113` cleanup stops heartbeat, closes the bridge/server, and marks the lockfile exited.
- `src/engine/ipc/server-entry.ts:115` through `src/engine/ipc/server-entry.ts:121` handles SIGTERM/SIGINT by marking the server signaled, calling cleanup, then `process.exit(0)`.
- That cleanup path does not call `killAllProcesses()` and does not abort the active workflow.

Impact:

- Killing a detached server during an active planner, implementer, or validation command can leave child runners alive with the project cwd and inherited environment after the parent exits successfully.

Fix:

- On detached server shutdown, abort the active workflow, call lifecycle-managed process cleanup, wait for child close/escalation, then mark the session interrupted/signaled.
- Add an IPC server signal test that registers a fake child and asserts it is terminated before exit.

Why not duplicate:

- P1-74 covers `killAllProcesses()` losing process-group metadata when it is called.
- This path skips runner cleanup entirely before exiting.

### P1-109: direct-write staging preserves links back outside the staged sandbox

Evidence:

- `src/engine/orchestrator/task/run-implementation.ts:48` creates a staged project for direct-write implementers.
- `src/engine/orchestrator/task/run-implementation.ts:55` and `src/engine/orchestrator/task/run-implementation.ts:60` run the implementer with the staged cwd/project directory.
- `src/engine/orchestrator/approval/staged-project.ts:25` recursively copies the project.
- `src/engine/orchestrator/approval/staged-project.ts:27` preserves symlinks with `verbatimSymlinks: true`.
- `src/engine/orchestrator/approval/staged-project.ts:30` excludes only `node_modules`, `.diptych`, and `.trees`.
- `src/engine/worktree.ts:104` through `src/engine/worktree.ts:107` read linked-worktree `.git` files pointing at external gitdirs.

Impact:

- The staged copy is not a real side-effect boundary.
- A direct runner can write through preserved repo symlinks to outside-project paths, or interact with git metadata outside the temp copy when copied from a linked worktree.
- Those mutations happen before changed-file approval and cannot be undone by deleting the staged temp directory.

Fix:

- Build staged workspaces from tracked regular files only.
- Exclude `.git`.
- Reject symlinks or materialize them safely.
- Verify all promoted/read paths with realpath confinement.
- Treat git metadata as outside the staged writable surface.

Why not duplicate:

- P1-46 covers secret-heavy temp copies and stale temp cleanup.
- P0-12 covers snapshot restore symlink/traversal.
- P1-66 covers autonomous runner tool permissions.
- This is specifically the direct-write staging sandbox preserving filesystem/git links that pierce the intended approval boundary.

### P1-110: review metadata refresh blocks the brief approval UI on full routing/file reads

Evidence:

- `src/features/workflow/components/brief-review-view.tsx:77` awaits `refreshPlanReviewMetadata(tasks)` before committing the loaded review data.
- `src/features/workflow/components/brief-review.ts:157` starts routing preview metadata for the entire task list.
- `src/features/workflow/components/brief-review.ts:205` through `src/features/workflow/components/brief-review.ts:213` refresh each modify task by reading the target file content from disk.
- `src/engine/orchestrator/context-routing/route.ts:6` maps all implementer profiles through assessment.
- `src/engine/orchestrator/context-routing/assessment.ts:37` through `src/engine/orchestrator/context-routing/assessment.ts:39` formats and estimates full task prompts.

Impact:

- Large plans, repeated large files, or many implementer profiles can stall the approval UI before the user can approve or edit the plan.

Fix:

- Render parsed tasks immediately.
- Refresh routing metadata in the background with bounded concurrency.
- Cache current-code reads by file.
- Defer routing/estimation for non-visible tasks.

Why not duplicate:

- P2-31 covers prompt materialization generally.
- P1-95 and P1-54 cover implementation-time snapshots.
- This is the review-screen hot path blocking approval UI startup.

### P1-111: approval feedback regeneration is announced but never written

Evidence:

- `src/engine/orchestrator/approval/approval.ts:56` calls `planner.regenerate`.
- `src/engine/orchestrator/approval/approval.ts:59` records usage, `src/engine/orchestrator/approval/approval.ts:60` marks regeneration, and `src/engine/orchestrator/approval/approval.ts:61` publishes `spec_regenerated` or `plan_regenerated`.
- `src/engine/orchestrator/approval/approval.ts` never writes `regenResult.text` back to the spec or plan artifact.
- `src/engine/planners/base.ts:264` defines `regenerate` as returning text.
- `src/engine/orchestrator/planning/full.ts:100` through `src/engine/orchestrator/planning/full.ts:118` later regenerate downstream artifacts from files, so stale `spec.md` or `plan.md` can be read.

Impact:

- User approval feedback can be silently discarded while the UI reports regeneration.
- The user may approve stale content and hand off a plan/spec that never incorporated required changes.

Fix:

- Persist regenerated spec/plan text inside `runApprovalLoop`, or make the caller persist immediately after each accepted regeneration before later phases read artifacts.
- Add approval-loop tests asserting feedback changes are written to the expected file before downstream regeneration.

Why not duplicate:

- Existing approval findings cover denial handling, validation approval tier behavior, and stale summary actions.
- None cover approval-loop regeneration being non-persistent.

### P1-112: RPC recovery actions can be queued before any recovery issue and applied to the wrong future issue

Evidence:

- `src/cli/rpc/dispatch.ts:90` accepts any `recovery` command and ACKs it.
- `src/cli/rpc/run.ts:96` creates a global `queuedRecoveryActions` list.
- `src/cli/rpc/run.ts:122` consumes queued recovery actions before waiting for the current recovery prompt.
- `src/cli/rpc/run.ts:128` through `src/cli/rpc/run.ts:129` enqueue recovery actions when no recovery gate is pending.

Impact:

- A stale or early `skip-current-task`, `retry-current-task`, or `abort-workflow` command can be applied automatically to an unrelated later recovery event.
- That bypasses contextual user approval and can skip work or abort a live session.

Fix:

- Reject recovery commands unless a recovery prompt is currently pending, or require a recovery issue id/token and only apply actions matching the active issue.
- Clear queued recovery state on prompt changes and aborts.
- Add RPC behavior tests for early/stale recovery commands and issue-token mismatches.

Why not duplicate:

- P1-76 covers RPC abort not resolving existing gates and clearing queues during abort.
- This is the inverse bug: accepting recovery actions when no gate exists and replaying them against a future recovery.

### P1-113: TUI rewind/redo targets `.diptych/active` instead of the visible workflow session

Evidence:

- `src/features/workflow/hooks/use-workflow-runner.ts:61` receives route `initialSessionId`.
- `src/features/workflow/hooks/use-workflow-runner.ts:83` tracks `activeSessionId = initialSessionId` for the run.
- `src/features/workflow/hooks/use-workflow-runner.ts:98` ignores that route session inside the rewind handler and calls `readActive(projectDir)`.
- `src/features/workflow/hooks/use-workflow-runner.ts:101` through `src/features/workflow/hooks/use-workflow-runner.ts:105` loads and saves rewind state under the active pointer's session ID.
- `src/app/command-context.ts:26` through `src/app/command-context.ts:31` has route-aware session lookup, but `src/app/command-context.ts:65` through `src/app/command-context.ts:70` calls `requestRewind` without passing the current route session into the workflow handler.

Impact:

- When the visible workflow was opened by explicit session ID, session picker, or any path where `.diptych/active` is missing/stale, `/revise-spec`, `/revise-plan`, or redo can mutate the wrong session or no-op while aborting or stranding the workflow the user is actually viewing.

Fix:

- Make rewind/redo handlers session-scoped.
- Pass the current route/session ID into the registered handler and reject if it does not match the running workflow.
- Add tests where `.diptych/active` is absent or points at a different session.

Why not duplicate:

- P1-61 covers `continue <id>` not claiming active ownership.
- This bug is specifically the rewind/redo state transition using a global active pointer instead of the current workflow route/session.

### P1-114: attached detached workflows have no IPC abort path

Evidence:

- `src/engine/ipc/protocol.ts:48` through `src/engine/ipc/protocol.ts:50` defines only `user_input`, `prompt_response`, and `detach` client messages.
- `src/engine/ipc/workflow-bridge.ts:26` makes the detached server abort handler a no-op.
- `src/engine/ipc/server.ts:254` through `src/engine/ipc/server.ts:269` handles only `user_input`, `prompt_response`, and `detach`.
- `src/app/keys.ts:58` through `src/app/keys.ts:61` calls the local `abortWorkflow` callback on Ctrl-C, but attached-mode IPC has no matching server control message.

Impact:

- A user attached to a detached session cannot stop a live expensive planner/implementer call from the TUI.
- Ctrl-C can make the client disappear while the server keeps running and may continue spending tokens or writing artifacts after the user believes they stopped it.

Fix:

- Add explicit IPC messages for aborting the current turn and/or workflow.
- Wire the bridge abort handler to the detached server's active controller.
- Have attached-mode Ctrl-C send that abort before exiting or detaching.
- Add an attach-mode behavior test that sends abort and asserts the server-side workflow receives it.

Why not duplicate:

- P1-38 and P1-67 cover abort propagation once the engine receives an abort signal.
- P1-56 and P1-88 cover detached launcher/crash cleanup.
- This is the missing client-to-server control path for attached detached sessions.

### P1-115: RPC `message` gate workflows lack behavior coverage

Evidence:

- `src/cli/rpc/types.ts:6` exposes `{ type: 'message', text: z.string().min(1) }`.
- `src/cli/rpc/dispatch.ts:75` through `src/cli/rpc/dispatch.ts:86` handles `message` by resolving `messageGate` or queueing text.
- `src/cli/rpc/callbacks.ts:33` through `src/cli/rpc/callbacks.ts:66` depends on `waitForMessage` for user-edit conflicts, planner questions, continuation prompts, and task-review prompts.
- `src/cli/rpc/run.test.ts` covers approval/status/reject/abort/recovery/slash queue behavior, but targeted search found no behavior test exercising these `message` gate callbacks.
- `src/cli/rpc/reader.test.ts:10` only parses a `message` command.

Impact:

- External RPC clients could lose the ability to answer planner questions, continuation prompts, user-edit conflicts, or task-review prompts while existing tests still pass.

Fix:

- Add `runRpc` behavior tests that trigger `onQuestionAsked`, `onContinuationNeeded`, `onUserEditConflict`, and `onTaskReviewNeeded`.
- Send `{"type":"message","text":"..."}` and assert callback result plus ACK/error stream shape.

Why not duplicate:

- P1-76 covers RPC abort pending gates.
- P1-79 covers exit status.
- P1-102 covers status leakage.
- P2-11 covers RPC architecture.
- This is an untested public `message` command contract.

### P2-37: collapsed implementer diff cards still process full diffs on every render

Evidence:

- `src/components/diff-view.tsx:74` splits and filters the full `diff` before checking collapsed state.
- `src/components/diff-view.tsx:75` slices visible lines before collapsed rendering.
- `src/components/diff-view.tsx:89` only then returns the collapsed branch.
- `src/features/workflow/components/event-cards/implementer-card.tsx:51` through `src/features/workflow/components/event-cards/implementer-card.tsx:56` passes full event diffs into `DiffView`.
- `src/engine/orchestrator/events.ts:285` publishes `implementer_generate_done` with diff data.

Impact:

- Large diffs create repeated CPU and allocation work during ordinary TUI rerenders even when collapsed.

Fix:

- Short-circuit the collapsed branch before splitting the diff.
- Store precomputed counts/preview metadata.
- Cap retained diff for TUI and split/highlight only when expanded.

Why not duplicate:

- P1-19 covers expensive diff computation.
- P1-6 and P1-8 cover streaming/output retention.
- This is the TUI render hot path for already-computed diffs.

### P2-38: `diptych ps` probes all sessions with unbounded concurrent subprocess checks

Evidence:

- `src/cli/commands/ps.ts:116` through `src/cli/commands/ps.ts:117` builds rows with `Promise.all(entries.map(...))`.
- `src/cli/commands/ps.ts:43` through `src/cli/commands/ps.ts:61` calls `deps.checkServerStatus(sessDir)` for each session with a lockfile.
- `src/engine/ipc/lockfile.ts:96` through `src/engine/ipc/lockfile.ts:104` can spawn `ps -o lstart= -p <pid>` per checked session.

Impact:

- Many detached/stale sessions can launch many `ps` subprocesses at once, slowing the recovery command and creating noisy behavior under recovery conditions.

Fix:

- Bound status-probe concurrency.
- Skip process spawn for clearly stale heartbeats.
- Consider batching or lazy probing.

Why not duplicate:

- P2-9 covers summary reads before slicing.
- P1-53 and P1-81 cover discovery correctness.
- This is unbounded process probing in `ps`.

### P2-39: `diptych resume --json` and `diptych resume --rpc` are unproven at the command seam

Evidence:

- `src/cli/commands/resume.ts:51` routes `opts.json` to `runHeadless`.
- `src/cli/commands/resume.ts:56` routes `opts.rpc` to `runRpc`.
- `docs/CLI-REFERENCE.md:496` documents `diptych resume --json --auto`.
- `docs/CLI-REFERENCE.md:499` documents `diptych resume --rpc`.
- `testing/integration/cli/resume-interrupted.test.ts:21` tests resume in the interrupted-session lane, but targeted search found no command-level `resume --json` or `resume --rpc` coverage.

Impact:

- The automation resume path can regress in active-session lookup, saved-state loading, flag parsing, or accidentally render Ink without lower-level `runHeadless`/`runRpc` tests failing.

Fix:

- Add command-level integration or `ResumeDeps` tests that seed `.diptych/active` and `state.json`.
- Run `resume --json` and `resume --rpc`.
- Assert driver routing, output shape, and no TUI render.

Why not duplicate:

- P0-3 is packaged CLI smoke.
- P1-42 is first-run `start --json/--rpc`.
- P1-79 is failed workflow exit status.
- This specifically covers the documented resume automation path.

### P2-40: `diptych migrate` has no CLI-level behavior coverage

Evidence:

- `docs/CLI-REFERENCE.md:752` through `docs/CLI-REFERENCE.md:804` documents the command, options, examples, and exit semantics.
- `src/cli/commands/migrate.ts:27` through `src/cli/commands/migrate.ts:32` registers `migrate` and `--project`.
- `src/core/migration/executor.test.ts:33` covers direct core migration calls.
- `testing/helpers/commander.ts:28` registers `migrate`, but targeted search found no `runCommand(["migrate"...])` or equivalent command-level migrate test.

Impact:

- Option parsing, stdout, exit-code behavior, and customer migration invocation can break while core migration tests pass.

Fix:

- Add a CLI integration test seeding `.diptych/current`.
- Run `diptych migrate --project <tmp>`.
- Assert exit 0, stdout, active pointer, migrated files, and idempotent second run.

Why not duplicate:

- P0-3, P1-31, and P2-35 cover other CLI smoke/command gaps.
- This is the distinct legacy migration command seam.

### P2-41: discovery store adapter depends on engine service contracts

Evidence:

- `docs/LAYERS.md` defines stores as lower-level state modules, while app/CLI glue should wire services.
- `src/stores/discovery/detection-adapter.ts:4` imports `DetectionDeps`, `DetectionServiceResult`, and `DetectionService` from `../../engine/detection/service.js`.
- `src/stores/discovery/detection-adapter.ts:16` exposes store APIs typed directly against that engine service.
- `src/cli/init-stores.ts:11` imports the engine detection service and `src/cli/init-stores.ts:78` passes it into the store adapter.

Impact:

- The store layer is no longer a neutral state boundary; it couples to engine service implementation contracts.
- Detection refactors touch stores/store tests and increase handoff/refactor blast radius.

Fix:

- Move the detection result/loader interface to `core`, or define a store-local adapter contract.
- Keep `getDefaultDetectionService()` wiring in CLI/app glue and pass plain results into stores.

Why not duplicate:

- P2-26 covers non-workflow feature imports from engine internals.
- This is a stores-to-engine boundary violation.

### P2-42: workflow handler registry is hidden global cross-boundary state

Evidence:

- `docs/LAYERS.md` describes feature boundaries and app-level composition.
- `src/app/command-context.ts:9` imports workflow feature handlers directly.
- `src/features/workflow/handlers.ts:19` stores mutable module-scope `handlers`.
- `src/features/workflow/hooks/use-workflow-runner.ts` installs handlers from a hook lifecycle, making runtime command behavior depend on feature-global state.
- `src/features/workflow/handlers.ts:70` through `src/features/workflow/handlers.ts:76` exports `requestAttach` and `requestDetach`, but targeted search found no call sites outside declarations; `src/app/command-context.ts` handles attachments directly.

Impact:

- Runtime command behavior depends on mutable feature-global state instead of an explicit store/app-composed callback contract.
- Stale wrappers make attachment flow harder to reason about.

Fix:

- Move cross-screen workflow commands into a store/core command adapter, or pass callbacks from `app.tsx` into `buildCommandContext`.
- Delete unused attachment wrappers.

Why not duplicate:

- P2-13 covers broad runtime command context shape.
- P2-26 covers feature-to-engine imports.
- This is hidden app-to-workflow global handler state plus dead exports.

---

## Updated Final Baseline For Next Loop (After Tenth Loop)

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.
- Fourth-loop findings.
- Fifth-loop findings P0-16 and P1-48 through P1-58.
- Sixth-loop findings P1-59 through P1-69.
- Seventh-loop findings P1-70 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.
- Ninth-loop findings P1-94 through P1-103 and P2-29 through P2-36.
- Tenth-loop findings P1-104 through P1-115 and P2-37 through P2-42.

Any further audit agent must first read this whole file and exclude every finding listed here. The prompt to each agent should explicitly say that P0-1 through P0-16, P1-1 through P1-115, and P2-1 through P2-42 are already-known findings and must not be reported again. Because the tenth loop still found new P1/P2 issues, the audit is not done. Future loops must report only new, non-duplicate findings, or explicitly state no-new-P0/P1/P2 for that lane after checking against this file.

---

## Eleventh Loop Findings - 2026-05-25

Scope:

- Eleventh-loop agents were explicitly given this audit file as the known-finding source.
- Exclusion set passed to every agent: P0-1 through P0-16, P1-1 through P1-115, and P2-1 through P2-42.
- Agents were instructed to report only new, non-duplicate findings or state no-new-P0/P1/P2 for their lane.
- Context7 documentation lookup was attempted for current library docs, but the Context7 quota was exceeded; verification below is source/local-code based.
- The installable CLI/package lane reported no-new-P0/P1/P2 after checking against the exclusion set.
- No new P0 findings were found in this loop.

### P1-116: detached IPC allows unauthenticated client takeover and prompt control

Evidence:

- `src/engine/ipc/protocol.ts:48` through `src/engine/ipc/protocol.ts:50` defines client messages as only `user_input`, `prompt_response`, and `detach`; there is no handshake, token, nonce, owner PID check, or attach authorization.
- `src/engine/ipc/server.ts:144` implements a second-connection control window where a bare `{ "kind": "detach" }` can detach the current client.
- `src/engine/ipc/server.ts:210` routes any second connection into that control-detach path when a client is already attached.
- `src/engine/ipc/server.ts:260` accepts `prompt_response` messages from the attached socket and resolves pending workflow gates.
- `src/cli/commands/detach.ts:51` sends exactly `{ kind: 'detach' }` over the socket.
- `docs/SUBSYSTEMS.md:41` documents that a second connection can send `{kind:'detach'}` to steal the session.

Impact:

- Any same-user local process that can reach `.diptych/sessions/<id>/ipc.sock` can detach the active UI client, attach itself, send user input, and answer approval/prompt gates.
- A malicious local helper, compromised editor extension, or stale script can steer a detached workflow after discovering the socket path from `diptych ps`, filesystem enumeration, or logs.
- This undermines localhost/local-endpoint hardening even though the endpoint is local-only.

Fix:

- Add per-session IPC authentication: generate a high-entropy attach token, store it in a secure file or lock metadata with mode checks, and require it in the first client message before accepting input or prompt responses.
- Require the same token for control-channel detach.
- Reject unauthenticated clients before replaying events or accepting responses.
- Add tests for unauthenticated attach, unauthenticated detach, authenticated attach, and authenticated control detach.

Why not duplicate:

- P1-21 and P1-22 cover filesystem hardening around `.diptych` paths and artifacts.
- P1-114 covers malformed IPC response payloads and log injection.
- This is the distinct valid-protocol IPC authorization gap: the server accepts control and prompt messages without proving the client is authorized.

### P1-117: `skip-current-task` recovery can leave workflow in a phase that cannot start the next task

Evidence:

- `src/core/state/machine.ts:70` allows `START_TASK` only from `implementing`.
- `src/core/state/machine.ts:77` allows `SKIP_TASK` in `implementing`, `validating-task`, and `escalating`.
- `src/core/state/machine.ts:81` allows `ALL_DONE` only from `implementing`.
- `src/core/state/machine.ts:233` handles `SKIP_TASK` by marking the task skipped and incrementing `currentTaskIndex`, but it does not reset `phase` to `implementing`.
- `src/engine/orchestrator/recovery/actions.ts:212` applies `SKIP_TASK` for `skip-current-task`, then `src/engine/orchestrator/recovery/actions.ts:216` resolves pending recovery without normalizing the phase.
- `docs/APPROVAL-AND-RECOVERY.md:174` says `skip-current-task` advances to the next task.

Impact:

- If recovery is invoked while the workflow is in `validating-task` or `escalating`, the state can remain in that phase after the current task is skipped.
- The next task cannot be started with `START_TASK`, and finalization cannot use `ALL_DONE`, because both are invalid outside `implementing`.
- A recovery path intended to unblock the run can instead create a resumable-looking session that is stuck in an invalid phase/action combination.

Fix:

- Make `SKIP_TASK` return to `phase: 'implementing'` whenever it advances task index, matching `advanceTask()`.
- Add state-machine tests for skipping from `validating-task` and `escalating`.
- Add a recovery-flow test that `skip-current-task` can continue to the next task or finalize after the skipped last task.

Why not duplicate:

- Existing recovery findings cover other resume, pending-recovery, and command-surface gaps.
- This is a concrete phase-transition bug in the `SKIP_TASK` state action used by recovery.

### P1-118: rewinding or regenerating tasks can leave evidence ledger entries stale or unable to record new tasks

Evidence:

- `src/core/state/machine.ts:275` and `src/core/state/machine.ts:286` clear `tasks` on `REWIND_TO_SPEC` and `REWIND_TO_PLAN`.
- `src/engine/orchestrator/planning/full.ts:165` clears only the drift-chain state when a rewind is consumed.
- `src/engine/orchestrator/evidence/persistence.ts:34` returns an existing evidence ledger as-is instead of rebuilding it when task ids or brief hashes change.
- `src/engine/orchestrator/evidence/ledger.ts:60` updates only tasks that already exist in the ledger.
- `src/engine/orchestrator/evidence/ledger.ts:80` returns an existing task entry when ids match, preserving old evidence fields.
- New task ids generated after rewind are not added to an existing ledger by the current `getOrCreateLedger()` path.

Impact:

- After a plan/spec rewind or task regeneration, `state.tasks` can represent a new task set while `evidence.json` still represents the old task set.
- Evidence for reused ids can retain stale validation/changed-file history.
- Evidence for new ids can be silently dropped because update helpers map over existing ledger tasks only.
- Handoff and review packets can present outdated or incomplete evidence for the actual task set.

Fix:

- Treat `hashTaskBrief(state.tasks)` as the evidence-ledger task-set version.
- When an existing ledger hash differs from the current task hash after rewind/regeneration, rebuild task entries from current tasks while preserving only session-level approvals/rejections that still apply.
- Add rewind/regeneration tests that assert stale task entries are removed and new task entries are recorded.

Why not duplicate:

- Earlier findings cover evidence persistence and handoff completeness in other paths.
- This is the specific mismatch between rewound/regenerated `state.tasks` and the existing `evidence.json` ledger.

### P1-119: cost-approval rejection creates a resumable-looking interrupted session but clears the active pointer

Evidence:

- `src/engine/orchestrator/run/phases.ts:190` calls `onCostApprovalNeeded` when estimated task cost exceeds the configured budget.
- `src/engine/orchestrator/run/phases.ts:191` returns `completed: false` if the user rejects the cost gate.
- `src/core/phases.ts:40` includes `implementing` in `RESUMABLE_PHASES`.
- `src/engine/orchestrator/run/run.ts:26` preserves the active session only for pending recovery or rewind aborts.
- `src/engine/orchestrator/session-lifecycle.ts:54` clears `.diptych/active` unless `preserveActive` is set.
- `src/cli/commands/resume.ts:31` relies on `.diptych/active` to find the session.

Impact:

- Rejecting a cost approval can leave `state.json` in a resumable phase while final session save marks the session interrupted and clears the active pointer.
- `diptych resume` then reports no active session even though there is a valid resumable session on disk.
- Users can lose the normal recovery path after doing the safe thing and rejecting a cost gate.

Fix:

- Preserve the active pointer when the run stops at a resumable cost gate, or transition to a clearly terminal/non-resumable state before clearing active.
- Add a cost-gate rejection test covering session status, active pointer, and `diptych resume` behavior.

Why not duplicate:

- Existing session-continuity findings cover other active-pointer and recovery cases.
- This is the specific cost-approval rejection path: it returns incomplete from `implementing` but does not request active-session preservation.

### P1-120: `state.external` and atomic state-write guarantees are documented but not implemented

Evidence:

- `docs/TASK-CONTRACT.md:123` says `state.json` is rewritten on every phase transition and every task status change.
- `docs/TASK-CONTRACT.md:129` documents an external metadata side channel at `state.external`.
- `docs/TASK-CONTRACT.md:142` guarantees that diptych preserves `state.external` on round-trip read/write.
- `src/core/schemas/workflow.ts` defines the workflow state schema without an `external` passthrough field.
- `src/core/state/persistence.ts:17` writes state with `writeSecureFile(join(dir, STATE_FILE), ...)`.
- `src/lib/fs.ts` writes secure files directly; the state persistence path does not do write-then-rename.

Impact:

- External tools following the task contract can add `state.external`, but diptych drops it on schema parse/save.
- File watchers or external integrators relying on atomic write-then-rename semantics can observe partial or inconsistent state writes.
- The public task contract is therefore not reliable for customers building board sync, automation, or external tooling.

Fix:

- Either implement the documented contract or remove it before handoff.
- If preserving it, add `external: z.record(z.unknown()).optional()` to the state schema, preserve it through transitions, and add round-trip tests.
- Add atomic state writes with a same-directory temporary file and rename, plus tests or an integration check for the persistence helper.

Why not duplicate:

- Prior findings cover schema/versioning and persistence gaps in other areas.
- This is the explicit mismatch between the published Task Contract and state persistence/schema behavior.

### P1-121: repo-map work ignores workflow abort

Evidence:

- `src/engine/orchestrator/run/phases.ts:60` passes `wctx.signal` into `runPlanningPhase`.
- `src/engine/orchestrator/planning/run.ts:51` calls `buildRepoMap(projectDir, ...)` before constructing the planner options.
- `src/engine/codebase/repomap.ts:13` defines `RepoMapOptions` without an abort signal.
- `src/engine/codebase/repomap.ts:38` discovers files and `src/engine/codebase/repomap.ts:45` parses them with `Promise.all(absFiles.map(...))`.
- `src/engine/codebase/repomap.ts:64` formats the final output after all parsing completes.

Impact:

- Cancelling a run during repo-map construction does not stop file discovery, parsing, cache writes, graph construction, PageRank, or formatting.
- Large repositories can remain CPU and I/O bound after the user cancels, delaying the TUI/RPC shutdown path and making abort feel broken before any model call starts.

Fix:

- Add `signal?: AbortSignal` to `RepoMapOptions`.
- Check `signal.aborted` before and after discovery, before parsing batches, inside long loops, and before formatting.
- Pass the workflow signal from `runPlanningPhase` into `buildRepoMap`.
- Add an abort test with a large synthetic project or mocked slow parser/cache.

Why not duplicate:

- Earlier abort findings cover model streams, validation subprocesses, RPC gates, and workflow signals.
- This is the repo-map/codebase-context pre-planner CPU/I/O path ignoring the workflow abort signal.

### P1-122: repo-map token budget is not a hard output cap

Evidence:

- `src/engine/codebase/budget.ts:5` implements `formatWithBudget`.
- `src/engine/codebase/budget.ts:23` deliberately always includes the first highest-ranked file, even when that file alone exceeds the configured token budget.
- `src/engine/codebase/format.ts:3` formats every symbol signature for a file without truncating inside the first file.
- `src/engine/codebase/repomap.ts:64` returns the formatted output directly to planner context.
- `src/engine/codebase/budget.test.ts:34` locks in the behavior with a tight budget where only the oversized first block is included.

Impact:

- `config.codebase.tokenBudget` is not an enforceable prompt-size limit.
- One large/high-ranked file can exceed the configured budget and push planner calls over context or cost expectations.
- Customers cannot rely on the knob for large monorepos or generated API files.

Fix:

- Enforce a true hard cap: truncate the first file block, truncate symbols, or skip blocks that cannot fit.
- Emit a clear truncation marker when the top file is reduced.
- Update docs/tests to distinguish soft ranking budget from hard maximum prompt budget.

Why not duplicate:

- Existing cost/context findings cover package size, prompt leakage, and broad context volume.
- This is the concrete repo-map budget implementation violating a user-facing token-budget control.

### P1-123: automatic context reads can escape the project via symlinks

Evidence:

- `src/engine/planners/context.ts:29` builds `<projectDir>/README.md`, then uses `access()` and `readFile()` without `lstat`, `realpath`, regular-file checks, or project confinement.
- `src/core/project-meta.ts:4` reads `<projectDir>/package.json` with `existsSync()` and `readFileSync()` without symlink checks.
- `src/engine/orchestrator/planning/speckit.ts:101` reads `.specify/memory/constitution.md`.
- `src/engine/handoff/write.ts:98` reads project-root `constitution.md` into handoff context.

Impact:

- A repository can symlink expected project context files to outside-project files.
- Diptych then reads and forwards outside-project content into planner prompts or handoff output during normal planning/handoff flows.
- This can exfiltrate local files without an explicit `@file` mention.

Fix:

- Before automatic context reads, `lstat` path components, require regular files, resolve `realpath`, and verify confinement under `projectDir`.
- Skip symlinks and non-regular files.
- Add size caps for README, package metadata, and constitution reads.
- Add tests for symlinked README/package/constitution files pointing outside the project.

Why not duplicate:

- P1-72 covers leaking raw in-repo README/package content.
- P0-12, P1-82, and P1-93 cover other symlink surfaces.
- This is the distinct automatic planner/handoff context path following project-root symlinks outside the repository.

### P1-124: workflow abort is not propagated into pre-hook subprocesses

Evidence:

- `src/features/workflow/hooks/use-workflow-runner.ts:92` cancels by aborting the workflow controller.
- `src/engine/hooks/run-pre-hook.ts:12` accepts hooks, event, payload, and context, but no `AbortSignal`.
- `src/engine/hooks/dispatch.ts:27` calls `spawnWithTimeout()` for command hooks without passing a signal.
- `src/lib/process/spawn.ts:142` already supports `signal?: AbortSignal`.
- Pre-hooks are used in planning, task, validation, commit, and escalation paths.

Impact:

- Cancelling a run during `pre_task`, `pre_step`, `pre_validation`, `pre_commit`, `pre_planning`, or `pre_escalation` does not stop an already-running hook subprocess.
- The hook can keep running in the project cwd with inherited environment until its timeout.
- This undermines cancel semantics and can leave untrusted hook commands running after the user believes the workflow has stopped.

Fix:

- Thread `AbortSignal` through `runPreHooks()` -> `runHook()` -> `runCommandHook()`.
- Pass the signal to `spawnWithTimeout`.
- Check `signal.aborted` between built-in hooks and configured hooks.
- Add abort behavior for module hooks or explicitly document that module hooks cannot be forcibly stopped.
- Add tests for aborting a long-running command hook.

Why not duplicate:

- P1-55 covers post-hook lifecycle/module timeout behavior.
- P1-99 covers validation subprocesses.
- P1-107 covers OS signals not aborting the workflow.
- This is the synchronous pre-hook path ignoring the existing workflow abort signal.

### P2-43: `continue` and `last` JSON/RPC modes are not proven at the command seam

Evidence:

- `docs/CLI-REFERENCE.md:549` documents `continue --json` and `continue --rpc`.
- `docs/CLI-REFERENCE.md:609` documents that `last` inherits `--json` and `--rpc`.
- `src/cli/commands/continue.ts:139` routes interrupted sessions to headless JSON mode when `opts.json` is set.
- `src/cli/commands/continue.ts:159` registers the Commander `continue` command.
- `src/cli/commands/last.ts:34` delegates to `continueCommand`.
- `src/cli/commands/continue.test.ts:158` covers `continueCommand(..., { rpc: true })` at direct function level.
- Targeted search found no Commander/integration test that invokes `diptych continue --json`, `diptych continue --rpc`, `diptych last --json`, or `diptych last --rpc`.

Impact:

- Flag registration, option parsing, stdout mode, and command wiring for these documented machine-readable paths can regress while direct function tests still pass.
- This is risky for external clients that depend on `continue`/`last` to resume interrupted sessions in automation.

Fix:

- Add CLI-level tests that seed an interrupted resumable session and run `diptych continue --json`, `diptych continue --rpc`, `diptych last --json`, and `diptych last --rpc`.
- Assert command routing, mutual exclusion, output shape, and noninteractive behavior.

Why not duplicate:

- P2-39 covers `resume --json` and `resume --rpc`.
- P1-42 covers first-run `start --json` and `start --rpc`.
- This is the distinct `continue` and `last` command seam.

### P2-44: `stats --rebuild` has no CLI-level behavior coverage

Evidence:

- `docs/CLI-REFERENCE.md:645` documents `diptych stats [--rebuild] [--json]`.
- `docs/CLI-REFERENCE.md:655` says `--rebuild` rebuilds `.diptych/stats.json` from completed session summaries.
- `docs/CLI-REFERENCE.md:694` says `--rebuild` writes `.diptych/stats.json`.
- `src/cli/commands/stats.ts:23` implements `--rebuild`.
- `src/cli/commands/stats.test.ts:34` and `src/cli/commands/stats.test.ts:62` cover JSON output paths, but targeted search found no `--rebuild` command test.

Impact:

- The documented recovery path for corrupted or stale aggregate stats can break without tests catching it.
- Customers relying on `stats --rebuild` as the recovery path for cost accounting may get stale or empty savings data.

Fix:

- Add a command test that writes completed and non-completed session summaries, runs `diptych stats --rebuild --json`, and asserts only completed sessions with cost data are included.
- Assert `.diptych/stats.json` is rewritten and human output reports the rebuilt session count.

Why not duplicate:

- Existing test-gap findings cover other CLI commands and machine-readable workflow paths.
- This is the specific documented stats rebuild behavior and its aggregate-cost recovery semantics.

### P2-45: `handoff --mode append` can publish a manifest for current tasks while retaining stale task files

Evidence:

- `src/engine/handoff/write.ts:112` computes `briefHash` from the current filtered tasks.
- `src/engine/handoff/write.ts:147` skips writing a pack file when `mode === 'append'` and the file already exists.
- `src/engine/handoff/write.ts:159` includes existing output files in `manifestPackFiles`.
- `src/engine/handoff/write.ts:165` builds the manifest from the current task list and the existing plus newly-written files.
- `src/engine/handoff/write.test.ts:162` explicitly locks in that skipped pre-existing task artifacts are still included in the manifest.

Impact:

- Re-running handoff append after tasks change can leave an old `tasks/T001.md` on disk while `manifest.json` advertises the current task hash and current task list.
- External agents can consume stale task files under a fresh manifest and implement the wrong brief.

Fix:

- In append mode, either refuse to skip changed task artifacts, write versioned task filenames, or compare each existing task file's embedded hash before including it in the manifest.
- Add a test where an existing task file has stale content and assert append refuses or rewrites it.

Why not duplicate:

- P1-13 covers broader handoff test-readback gaps.
- This is the concrete append-mode writer behavior that mixes current manifest metadata with stale task artifacts.

### P2-46: Task Brief markdown round-trip drops `scope.approvedOutOfBounds`

Evidence:

- `src/core/schemas/task.ts:57` includes optional `scope.approvedOutOfBounds`.
- `docs/PLANNERS-AND-IMPLEMENTERS.md:112` maps Scope to `scope.inBounds`, `scope.outOfBounds`, and `scope.approvedOutOfBounds`.
- `docs/TROUBLESHOOTING.md:243` tells users to add legitimate out-of-scope paths to `scope.approvedOutOfBounds` in the brief.
- `src/engine/spec/formatter.ts:3` and `src/engine/spec/formatter.ts:14` format only in-bounds and out-of-bounds scope buckets.
- `src/engine/spec/parser.ts:175` extracts only `scopeInBounds` and `scopeOutOfBounds`.
- Targeted search found no parser/formatter support for an approved-out-of-bounds bucket.

Impact:

- A user or planner can add `scope.approvedOutOfBounds` in structured task data, but exporting/editing/importing the markdown brief loses it.
- Legitimate shared-file approvals disappear, causing drift warnings/escalations or approval prompts to reappear after a brief round-trip.

Fix:

- Extend Task Brief v1 markdown with an explicit `Approved out of bounds` bucket.
- Teach formatter and parser to preserve it.
- Add round-trip tests for `scope.inBounds`, `scope.outOfBounds`, and `scope.approvedOutOfBounds`.

Why not duplicate:

- Existing drift and brief findings cover other scope/approval behavior.
- This is the specific markdown serialization gap for an already-documented schema field.

### P2-47: readiness reports echo secret-bearing validation commands

Evidence:

- `src/core/readiness/checks/validation.ts:26` adds `Test command: ${config.validation.testCommand ?? 'npm test'}` to readiness check details.
- `src/core/readiness/checks/validation.ts:31` stores the full effective `testCommand` in check metadata.
- `src/core/readiness/checks/validation.ts:91` and `src/core/readiness/checks/validation.ts:100` echo the configured command into missing-package-script warnings.
- `src/cli/commands/start.ts:186` emits readiness reports on `start --json`.
- `src/cli/commands/start.ts:199` emits readiness reports on `start --rpc`.
- `src/cli/commands/doctor.ts:23` emits readiness reports on `doctor --json`.
- `src/core/readiness/format.ts:93` persists blocker/warning readiness summaries into session start-readiness records.

Impact:

- If a user places tokens, credentials, or private URLs in `validation.testCommand`, readiness output can expose them in stdout NDJSON/RPC streams, doctor JSON, or persisted readiness summaries.
- This is especially risky for CI logs and external orchestration clients consuming machine-readable readiness output.

Fix:

- Redact common secret patterns and environment assignments in readiness output and metadata.
- Prefer showing command name/script name only unless verbose diagnostics are explicitly requested.
- Add tests for commands containing `TOKEN=`, `PASSWORD=`, bearer-like strings, and private registry URLs.

Why not duplicate:

- P0-5 and P1-50 cover validation output handling in runtime validation paths.
- P0-14 and P1-91 cover validation execution/approval posture.
- P1-25 covers event/session persistence more broadly.
- This is the readiness-report echo path before validation execution.

### P2-48: cold repo-map cache writes one synchronous SQLite upsert per parsed file

Evidence:

- `src/engine/codebase/repomap.ts:45` parses all discovered files through `Promise.all(absFiles.map(f => cache.getOrParse(f, parseFile)))`.
- `src/engine/codebase/cache.ts:28` opens a `better-sqlite3` database.
- `src/engine/codebase/cache.ts:44` prepares a single-row upsert.
- `src/engine/codebase/cache.ts:80` calls `upsert.run(...)` for every parsed cache miss.
- There is no transaction around the cold-cache batch.

Impact:

- On first run or after cache invalidation, every parsed file performs its own synchronous SQLite write.
- Large repositories can spend significant time in repeated fsync/SQLite overhead before planning starts.
- This compounds the abort issue in P1-121 because the work is not cancellable.

Fix:

- Batch cold-cache writes in a transaction, or expose a cache batch API that wraps multiple upserts in one transaction.
- Consider limiting parse concurrency separately from DB writes.
- Add a benchmark or test seam that verifies cold-cache writes use a transaction.

Why not duplicate:

- P1-121 covers abort propagation for repo-map work.
- P1-122 covers output budget enforcement.
- This is the distinct cold-cache write-amplification performance issue.

### P2-49: legacy migration can follow `.tiny-spec` symlink and clean up outside-project data

Evidence:

- `src/core/migration/executor.ts:24` builds the legacy `.diptych/current` path and `src/core/migration/executor.ts:26` builds `.tiny-spec/current`.
- `src/core/migration/executor.ts:29` and `src/core/migration/executor.ts:31` choose a source directory using `existsSync()` without symlink checks.
- `src/core/migration/executor.ts:39` reads migration state from the chosen source.
- `src/core/migration/executor.ts:95` runs `rmSync(sourceDir, { recursive: true, force: true })`.
- `src/cli/commands/start.ts:179` runs migration automatically before start flow output.

Impact:

- If `.tiny-spec` is a symlink to an outside directory, automatic migration can read outside legacy state and then delete the outside `current` directory after migration.
- This creates a low-frequency but serious data-loss path for users with legacy or accidentally symlinked project metadata.

Fix:

- `lstat` `.diptych`, `.tiny-spec`, and `current` path components before migration.
- Reject symlinked migration source directories or require explicit user confirmation.
- Resolve `realpath` and verify project confinement before all reads and before cleanup.
- Only remove a verified in-project legacy directory.

Why not duplicate:

- Existing symlink findings cover `.diptych` writes, snapshot restore, `.gitignore`, direct-write staging, and automatic context reads.
- This is the legacy `.tiny-spec/current` migration source and cleanup path.

---

## Updated Final Baseline For Next Loop (After Eleventh Loop)

All findings above are now part of the audit baseline:

- Original findings.
- Second-loop findings.
- Third-loop findings.
- Fourth-loop findings.
- Fifth-loop findings P0-16 and P1-48 through P1-58.
- Sixth-loop findings P1-59 through P1-69.
- Seventh-loop findings P1-70 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.
- Ninth-loop findings P1-94 through P1-103 and P2-29 through P2-36.
- Tenth-loop findings P1-104 through P1-115 and P2-37 through P2-42.
- Eleventh-loop findings P1-116 through P1-124 and P2-43 through P2-49.

Any further audit agent must first read this whole file and exclude every finding listed here. The prompt to each agent must explicitly say that P0-1 through P0-16, P1-1 through P1-124, and P2-1 through P2-49 are already-known findings and must not be reported again. Future agents should also receive the concrete "why not duplicate" notes above so they do not rename the same issue under a different title. Because the eleventh loop still found new P1/P2 issues, the audit is not done. Future loops must report only new, non-duplicate findings, or explicitly state no-new-P0/P1/P2 for that lane after checking against this file.

---

## Twelfth Loop Findings - 2026-05-25

Scope:

- Twelfth-loop agents were explicitly given this file as the baseline and told to exclude P0-1 through P0-16, P1-1 through P1-124, and P2-1 through P2-49.
- The agents were also told to pass forward concrete "why not duplicate" notes so later agents stop rediscovering renamed versions of existing issues.
- Lanes covered MCP/local endpoints, secrets/privacy/logs, installable CLI/package, filesystem safety, performance/resource exhaustion, behavior tests/release gates, clean-code/architecture, and workflow/session/handoff reliability.
- Context7 current-doc lookup was attempted for Vitest but failed with a monthly quota error. Local code verification was used for all findings.
- SOTA source notes used by agents: official MCP transport/security/authorization docs for local endpoint auth and least-privilege guidance, and OWASP Logging Cheat Sheet guidance for excluding secrets and sanitizing/capping logged event data.
- The installable CLI/package lane reported no-new-P0/P1/P2 after checking against this exclusion set.
- No new P0 findings were found in this loop.
- Agent-local P2 labels from this loop were renumbered below to preserve the file-wide sequence.

### P1-125: MCP read access and evidence-write tools share one bearer token with no scopes

Evidence:

- `src/cli/commands/mcp.ts:62` generates one token.
- `src/cli/commands/mcp.ts:64` creates the MCP resource resolver, and `src/cli/commands/mcp.ts:65` always creates the evidence tool handler.
- `src/engine/mcp/server.ts:142` through `src/engine/mcp/server.ts:145` applies a single bearer-token check before all MCP routes.
- `src/engine/mcp/handlers.ts:80` through `src/engine/mcp/handlers.ts:83` advertises tools whenever a tool handler exists.
- `src/engine/mcp/handlers.ts:143` through `src/engine/mcp/handlers.ts:155` routes `tools/call` under the same authorization boundary.
- Evidence tools mutate the ledger in `src/engine/mcp/tool/operations.ts:118`, `src/engine/mcp/tool/operations.ts:143`, `src/engine/mcp/tool/operations.ts:172`, and `src/engine/mcp/tool/operations.ts:235`.

Impact:

- A client configured only to inspect MCP resources also receives write capability for progress, errors, validation results, and task completion evidence.
- A leaked token or compromised MCP client can falsify handoff evidence for the intended served session without a second consent or scope boundary.

Fix:

- Default MCP to read-only, or require an explicit `--enable-evidence-tools` flag.
- Issue separate scoped credentials such as `resources:read` and `evidence:write`.
- Enforce scope in `tools/list` and `tools/call`.
- Display write scope clearly in startup output and docs.

Why not duplicate:

- P1-1 covers wrong-session mutation by tools.
- P1-73 covers secret-bearing MCP text persistence.
- P1-105 covers raw `state.json` exposure.
- This is the missing read/write authorization and least-privilege boundary for the intended served session.

### P1-126: CLI planner artifact ingestion can follow symlinked project artifacts outside the repo

Evidence:

- `src/engine/planners/cli.ts:21` through `src/engine/planners/cli.ts:26` checks containment lexically with `resolve()` and `relative()`, without `lstat`, `realpath`, or regular-file checks.
- `src/engine/planners/cli.ts:28` through `src/engine/planners/cli.ts:31` accepts a matching basename and calls `readFileSafe(candidate)`.
- `src/engine/planners/cli.ts:48` through `src/engine/planners/cli.ts:51` reads model-linked artifacts.
- `src/engine/planners/cli.ts:54` through `src/engine/planners/cli.ts:56` also reads project-root artifacts when output says it wrote them.
- `src/engine/planners/base.ts:208` through `src/engine/planners/base.ts:212` replaces the phase output with that artifact text, which later planner phases consume.

Impact:

- A repo can pre-place `research.md`, `spec.md`, `plan.md`, or `tasks.md` as symlinks to outside files.
- If the CLI planner output links or mentions the artifact, Diptych can read outside content and feed it into later planner phases and session artifacts.

Fix:

- Resolve artifact candidates relative to `projectDir`.
- `lstat` candidates, reject symlinks, require regular files, and `realpath`-check confinement under `projectDir`.
- Prefer reading planner artifacts only from the session artifact directory.

Why not duplicate:

- P1-123 covers automatic README/package/constitution context reads.
- P1-82 covers MCP session artifact reads.
- This is the CLI planner `readPhaseOutput` artifact-ingestion path.

### P1-127: approval rollback dirty-file snapshots can write through symlinks

Evidence:

- `src/lib/git.ts:97` through `src/lib/git.ts:99` returns raw Git status paths.
- `src/engine/orchestrator/approval/file-snapshots.ts:32` through `src/engine/orchestrator/approval/file-snapshots.ts:36` snapshots dirty file contents with plain `readFile(join(projectDir, file))`.
- `src/engine/orchestrator/approval/file-snapshots.ts:122` through `src/engine/orchestrator/approval/file-snapshots.ts:129` restores stored content with plain `writeFile(join(projectDir, file), ...)`.
- `src/engine/orchestrator/task/apply-changed-files.ts:70` through `src/engine/orchestrator/task/apply-changed-files.ts:79` invokes that rollback after a changed-file approval denial.

Impact:

- If a dirty Git path is or becomes a symlink, rollback can restore captured content by writing through the symlink target outside the project.
- A denial safety path can become an outside-file overwrite/data-loss path.

Fix:

- For dirty-file snapshot and rollback paths, reject symlinks, require regular files, and `realpath`-check project confinement.
- Restore symlink metadata as symlink metadata, or skip with an explicit conflict.

Why not duplicate:

- P0-12 covers the session snapshot subsystem restore/capture path.
- P1-109 covers direct-write staging preserving symlinks.
- This is the approval dirty-file snapshot/rollback path used after denied changed-file gates.

### P1-128: `worktree remove` can delete a worktree with a live detached session

Evidence:

- `docs/CLI-REFERENCE.md:1293` says remove refuses live sessions by default.
- `docs/CLI-REFERENCE.md:161` says `--detach --worktree` starts the detached server inside the new worktree.
- `src/cli/commands/start.ts:152` through `src/cli/commands/start.ts:154` creates detached session directories directly with `generateSessionId()` and `ensureSessionDir()`, not the active-session pointer path.
- `src/engine/worktree.ts:214` through `src/engine/worktree.ts:218` checks only `.diptych/active` to detect live sessions.
- `src/engine/worktree.ts:250` always runs `git worktree remove <path> --force`.

Impact:

- A detached workflow in `.trees/<slug>` can still be running with a lockfile/socket while no `.diptych/active` pointer exists.
- `diptych worktree remove <slug>` can remove that worktree and its `.diptych/sessions` state under a live background server.

Fix:

- Detect live sessions from lockfiles in the worktree-local `.diptych/sessions/*`, not only `.diptych/active`.
- Refuse unless `--force`.
- Avoid passing Git `--force` unless the user requested force.

Why not duplicate:

- P1-56 covers detached startup timeout cleanup.
- P2-25 covers lockfile heartbeat races.
- P2-10 covers git boundary placement.
- This is the specific worktree removal guard missing detached lockfile-backed sessions.

### P1-129: external `diptych detach` is undone by attached-client autoreconnect

Evidence:

- `src/cli/commands/detach.ts:50` through `src/cli/commands/detach.ts:52` sends `{ kind: 'detach' }` from a second socket.
- `src/engine/ipc/server.ts:177` through `src/engine/ipc/server.ts:181` accepts that control detach and destroys the current client socket.
- `src/engine/ipc/server.ts:224` through `src/engine/ipc/server.ts:226` clears the server-side client without sending a semantic "forced detached" reason to the old client.
- `src/features/workflow/hooks/use-ipc-client.ts:195` through `src/features/workflow/hooks/use-ipc-client.ts:202` treats socket close as reconnectable and schedules reconnect attempts.
- `src/features/workflow/hooks/use-ipc-client.ts:256` through `src/features/workflow/hooks/use-ipc-client.ts:260` suppresses reconnect only for the local `detach()` action.

Impact:

- `diptych detach <session>` can print success while the attached TUI immediately reconnects and reclaims the socket.
- Detach/attach lifecycle becomes unreliable and can block another terminal from attaching.

Fix:

- Add an explicit server message or close reason for forced detach.
- Have the client stop reconnecting on that reason.
- Add an integration test with an attached `useIpcClient` client plus an external detach command.

Why not duplicate:

- P1-116 covers unauthenticated IPC takeover/control.
- P1-114 covers missing IPC abort.
- This is the legitimate detach lifecycle being non-sticky because the client autoreconnects.

### P1-130: transcript compaction can build one unbounded summarization prompt

Evidence:

- `src/core/sessions/compaction.ts:67` through `src/core/sessions/compaction.ts:71` reads the full session log into `entries`.
- `src/core/sessions/compaction.ts:42` through `src/core/sessions/compaction.ts:44` slices all older messages into `summaryInput`.
- `src/engine/planners/base.ts:135` through `src/engine/planners/base.ts:138` formats all messages into one transcript string.
- `src/engine/planners/base.ts:334` through `src/engine/planners/base.ts:338` sends that full summary prompt to the planner.

Impact:

- `/compact-transcript` and resume-time auto-compaction can spike memory and send a huge paid planner request before compaction has actually reduced anything.

Fix:

- Compact in bounded chunks.
- Enforce byte/token limits before summarization.
- Summarize incrementally and keep only a bounded tail plus the latest valid summary.

Why not duplicate:

- P1-68 covers resume rebuilding and resending prior transcript.
- This is the compaction operation itself becoming the resource-exhaustion path.

### P2-50: MCP startup UX encourages persisting the live bearer token in project-tracked Claude settings

Evidence:

- `src/cli/commands/mcp.ts:91` prints the live token.
- `src/cli/commands/mcp.ts:94` through `src/cli/commands/mcp.ts:103` prints a ready-to-paste `.claude/settings.json` block containing `Authorization: Bearer <token>`.
- `docs/CLI-REFERENCE.md:1192` documents that behavior.
- `docs/USAGE-EXAMPLES.md:970` through `docs/USAGE-EXAMPLES.md:982` shows the token inside `.claude/settings.json`.
- `.gitignore:1` through `.gitignore:20` does not ignore `.claude/settings.json`.
- `.claude/settings.json` is tracked in this repository.
- `docs/TROUBLESHOOTING.md:604` suggests teeing the startup banner to a file.

Impact:

- The auth token is described as in-memory, but the product UX nudges users toward writing it into a project-local, potentially tracked/readable file.
- During the server lifetime, that token grants MCP access; with P1-125, it also grants evidence-write authority.

Fix:

- Do not print a project-file config block containing the literal token by default.
- Prefer a user-private non-versioned config path, an env-var placeholder, or a `0600` temp credential file outside the repo.
- Document that project-tracked MCP configs must not contain live tokens.

Why not duplicate:

- Existing token/leak findings cover validation output, malformed IPC/RPC logs, argv prompts, and evidence text.
- This is the MCP server credential distribution path and project-local config guidance.

### P2-51: `mcp serve` localhost-only binding is not protected by a CLI behavior test

Evidence:

- `src/cli/commands/mcp.ts:69` through `src/cli/commands/mcp.ts:75` passes the server config with `host: '127.0.0.1'`.
- `docs/CLI-REFERENCE.md:1188` and `docs/CLI-REFERENCE.md:1203` promise localhost-only binding.
- `src/cli/commands/mcp.test.ts:28` through `src/cli/commands/mcp.test.ts:36` fakes `startMcpServer()` without inspecting the server config.
- `src/cli/commands/mcp.test.ts:129` through `src/cli/commands/mcp.test.ts:138` asserts printed URL/token text only.
- `src/engine/mcp/server.test.ts:17` through `src/engine/mcp/server.test.ts:24` starts the server directly with `host: '127.0.0.1'`, so it does not prove the CLI passes that binding.

Impact:

- A regression from `127.0.0.1` to `0.0.0.0` in the CLI command layer could expose the local MCP server beyond localhost while existing command tests still pass.

Fix:

- Capture the `startMcpServer()` argument in `mcp.test.ts`.
- Assert `host === '127.0.0.1'`, token present, resolver present, and tool handler present.
- Add one CLI-level test that fails if startup output and actual server config diverge.

Why not duplicate:

- P2-19 covers real MCP evidence tools over HTTP and `toolHandler` wiring.
- P1-1 and P1-2 cover MCP tool scope/origin behavior.
- This is specifically the CLI localhost-binding release gate.

### P2-52: `worktree remove` tests assert success text but not destructive flags reaching git behavior

Evidence:

- `docs/CLI-REFERENCE.md:1289` through `docs/CLI-REFERENCE.md:1293` documents `--force` and `--delete-branch`.
- `src/cli/commands/worktree.ts:184` through `src/cli/commands/worktree.ts:189` passes `force` and `deleteBranch` into `removeWorktree()`.
- `src/cli/commands/worktree.test.ts:140` through `src/cli/commands/worktree.test.ts:147` checks only printed output for `--force` and `--delete-branch`.
- Real Git behavior is tested lower down at the engine seam, for example `src/engine/worktree.test.ts:251` through `src/engine/worktree.test.ts:257`, not through the CLI parser.

Impact:

- The CLI could stop passing `force` or `deleteBranch` while still printing "Removed" or "Deleted branch".
- This is risky because `worktree remove` can delete a branch and bypass live-session or dirty-worktree guards when forced.

Fix:

- In CLI command tests, assert `mockRemoveWorktree()` receives `{ force: true }` and `{ deleteBranch: true }`.
- Add one Commander-level integration test against a real Git worktree for `worktree remove --force --delete-branch`.

Why not duplicate:

- P1-92 covers git mutation approval.
- P2-10 covers git boundary drift.
- Existing worktree engine coverage does not protect this CLI parser seam.

### P2-53: `handoff --task` can export tasks without required dependencies

Evidence:

- `docs/CLI-REFERENCE.md:834` documents `--task <ids>` as a task subset export.
- `src/engine/handoff/write.ts:103` through `src/engine/handoff/write.ts:110` maps only the explicitly selected IDs.
- `src/engine/handoff/write.ts:114` through `src/engine/handoff/write.ts:120` passes only `filteredTasks` to the renderer.
- `src/engine/handoff/renderers/shared.ts:9` through `src/engine/handoff/renderers/shared.ts:10` preserves `dependsOn` in the task brief.
- `src/engine/handoff/manifest.ts:45` writes `taskIds` from only the exported tasks.
- `src/engine/handoff/write.test.ts:27` through `src/engine/handoff/write.test.ts:32` has dependent fixture tasks, but selected-task tests cover unknown IDs rather than dependency closure.

Impact:

- Exporting `--task T003` can produce a pack where `T003.md` says it depends on `T001` or `T002`, but those briefs are absent from `tasks/` and `manifest.json`.
- External agents can implement out of order or without prerequisite context.

Fix:

- Close the dependency graph automatically.
- Reject subsets with missing dependencies unless an explicit `--allow-missing-deps` option is added.
- Sort exported task files and manifest IDs topologically.

Why not duplicate:

- P1-13 is broad handoff readback coverage.
- P2-45 is append-mode stale files.
- P1-23 is task ID/path collision.
- This is specifically dependency closure and ordering for selected handoff exports.

### P2-54: workflow conversation virtualization still rescans full history every render

Evidence:

- `src/stores/workflow/actions.ts:136` through `src/stores/workflow/actions.ts:139` recomputes sections whenever the events array reference changes.
- `src/core/layout/event-sections.ts:55` through `src/core/layout/event-sections.ts:60` loops the full event list and builds section ranges.
- `src/core/layout/conversation-scroll.ts:48` through `src/core/layout/conversation-scroll.ts:52` filters all sections and builds all renderable items.
- `src/core/layout/renderable-conversation.ts:142` through `src/core/layout/renderable-conversation.ts:146` processes renderable events before viewport trimming.
- `src/features/workflow/components/conversation-flow/flow.tsx:135` through `src/features/workflow/components/conversation-flow/flow.tsx:139` builds keys for all renderable items, then trims to visible items.

Impact:

- Long sessions can stall Ink even when only a small viewport is visible.

Fix:

- Maintain incremental section and height metadata.
- Use prefix sums/binary search for viewport windows.
- Build keys only for visible items.

Why not duplicate:

- P1-6 is planner-text-specific.
- P2-37 is diff-specific.
- P1-87 is session-tree recorder performance.
- This is the general TUI conversation layout path.

### P2-55: API implementer streaming preview keeps growing single-line chunks

Evidence:

- `src/engine/orchestrator/task/streaming-feed.ts:37` through `src/engine/orchestrator/task/streaming-feed.ts:39` appends every chunk to `remainder`.
- `src/engine/orchestrator/task/streaming-feed.ts:45` through `src/engine/orchestrator/task/streaming-feed.ts:47` pushes the full growing remainder when no newline appears.
- `src/stores/workflow/streaming-output.ts:26` through `src/stores/workflow/streaming-output.ts:29` stores those full strings.
- `src/features/workflow/components/event-cards/streaming-lines.tsx:13` through `src/features/workflow/components/event-cards/streaming-lines.tsx:16` only truncates at render time.

Impact:

- A model streaming minified code or one long line can cause repeated large string copies and retained huge preview strings.

Fix:

- Cap `remainder`.
- Cap stored preview line length.
- Push truncated preview strings while retaining full output only in the implementer result path.

Why not duplicate:

- P1-8 covers subprocess/IPC output buffering and backpressure.
- This is the separate API implementer TUI preview buffer.

### P2-56: review-packet generation accumulates every session event

Evidence:

- `src/engine/orchestrator/evidence/review-packet/build.ts:221` creates an unbounded `events` array.
- `src/engine/orchestrator/evidence/review-packet/build.ts:222` reads all persisted events.
- `src/engine/orchestrator/evidence/review-packet/build.ts:250` pushes every packet event.
- `src/engine/orchestrator/final-review.ts:121` through `src/engine/orchestrator/final-review.ts:124` runs this during finalization.

Impact:

- Finalization can stall or create oversized `review-packet.json` for long sessions.

Fix:

- Roll up events by type, task, and recovery metadata.
- Cap raw event samples.
- Stream aggregate counters instead of persisting every packet event.

Why not duplicate:

- Existing review-packet findings cover privacy and evidence correctness.
- This is finalization-time event rollup growth.

### P2-57: OpenAI-compatible API planner calls have no output-token cap

Evidence:

- `src/engine/planners/api.ts:37` through `src/engine/planners/api.ts:40` calls `dispatchStreamCompletion()` without `maxTokens`.
- `src/engine/providers/openai-stream.ts:94` through `src/engine/providers/openai-stream.ts:101` only sends `max_tokens` when provided.
- `src/engine/providers/openai-stream.ts:112` through `src/engine/providers/openai-stream.ts:120` accumulates the full response string.
- `src/engine/implementers/api.ts:27` through `src/engine/implementers/api.ts:31` derives a `maxTokens` cap for API implementers, so the planner path is the gap.

Impact:

- Planner phases can produce oversized responses, higher costs, and large retained planner text on OpenAI-compatible providers.

Fix:

- Derive planner `maxTokens` from configured/model context length and phase.
- Pass it to `dispatchStreamCompletion()`.
- Test OpenAI-compatible request bodies.

Why not duplicate:

- P1-122 is repo-map token budget.
- P1-75 is planner timeout.
- P1-6 is TUI planner-text rendering after output exists.
- This is the provider request missing an output cap.

### P2-58: mode advisor state is a hidden engine singleton that can leak stale UI advice across resume flows

Evidence:

- `src/engine/orchestrator/planning/mode-advisor.ts:270` through `src/engine/orchestrator/planning/mode-advisor.ts:274` creates and exports a module-scope advisory store.
- `src/engine/orchestrator/planning/run.ts:16` through `src/engine/orchestrator/planning/run.ts:17` writes to that global during planning.
- `src/engine/orchestrator/run/phases.ts:58` through `src/engine/orchestrator/run/phases.ts:62` skips planning on normal resume, so advisory is not recomputed.
- `src/stores/workflow/actions.ts:70` through `src/stores/workflow/actions.ts:74` resets workflow stores but does not clear this advisory singleton.
- `src/features/workflow/hooks/use-advisory.ts:1` through `src/features/workflow/hooks/use-advisory.ts:6` imports engine internals directly for UI state.

Impact:

- Resumed workflows can display stale mode/risk advice from a previous run.
- The design creates hidden cross-boundary UI state in `engine/`, outside the documented store/event flow.

Fix:

- Move advisory state into the workflow/lifecycle store or derive it from `mode_advice` events.
- Clear advisory state in `resetWorkflow()`.
- Have UI subscribe to stores instead of engine module globals.

Why not duplicate:

- P2-42 covers workflow handler registry globals.
- P2-26 covers non-workflow feature imports from engine.
- This is a distinct engine-owned UI advisory singleton with resume/reset staleness.

### P2-59: HTML export silently omits corrupt evidence/drift/brief-quality artifacts

Evidence:

- `src/engine/export/collect.ts:32` through `src/engine/export/collect.ts:34` reads optional evidence, drift, and brief-quality artifacts.
- `src/engine/export/collect.ts:36` through `src/engine/export/collect.ts:43` includes them only when truthy while returning `status: 'ok'`.
- `src/engine/export/collect.ts:84` through `src/engine/export/collect.ts:91` treats missing and malformed `evidence.json` the same as `null`.
- `src/engine/export/collect.ts:103` through `src/engine/export/collect.ts:117` does the same for drift and brief-quality artifacts.
- `src/engine/export/collect.test.ts:117` through `src/engine/export/collect.test.ts:122` only proves missing optional artifacts are omitted; corrupt optional artifacts are not distinguished.

Impact:

- A customer-facing handoff/export report can look successful while silently dropping failed drift, missing evidence, or brief-quality data because the artifact is malformed.

Fix:

- Distinguish missing from present-but-invalid optional artifacts.
- Return `invalid` or include explicit export warnings.
- Add tests for corrupt `evidence.json`, `drift-report.json`, and `brief-quality.json`.

Why not duplicate:

- P1-118 covers stale evidence after rewind/regeneration.
- P2-45 covers handoff append artifacts.
- P2-24 covers malformed config fallback.
- This is specifically the HTML export path producing a successful but incomplete report.

### P2-60: live cassette recording persists raw provider traffic into durable repo/eval artifacts

Evidence:

- `testing/helpers/cassette/requests.ts:18` through `testing/helpers/cassette/requests.ts:23` normalizes `init.body` with `String(init.body)`, preserving the full provider request body.
- `testing/helpers/cassette/recorder.ts:6` through `testing/helpers/cassette/recorder.ts:11` redacts only `authorization` and `x-api-key` request headers.
- `testing/helpers/cassette/recorder.ts:41` through `testing/helpers/cassette/recorder.ts:56` reads the full response body and stores raw request body, response headers, and response body in cassette entries.
- `testing/helpers/cassette/recorder.ts:73` through `testing/helpers/cassette/recorder.ts:82` writes cassette JSON to disk without redaction, sanitization, or size caps.
- `testing/e2e/helpers/e2e-harness.ts:34` records into `testing/e2e/cassettes`.
- `testing/e2e/helpers/e2e-harness.ts:71` through `testing/e2e/helpers/e2e-harness.ts:73` enables that path with `DIPTYCH_E2E_RECORD=1`.
- `package.json:24` exposes `test:e2e:record`, and `package.json:26` exposes `eval:record`.
- `docs/superpowers/specs/2026-04-30-real-e2e-tests/spec.md:855` through `docs/superpowers/specs/2026-04-30-real-e2e-tests/spec.md:868` documents recording with real API credentials and writing cassettes to `testing/e2e/cassettes/`.
- `testing/e2e/cassettes/*.json` files are tracked in this repository; `evals/cassettes/*` is ignored but still becomes long-lived local data.

Impact:

- A live re-record can persist prompts, repo context, source snippets, validation text, model responses, and echoed secrets into cassette JSON.
- E2E cassettes live in a tracked path, so a maintainer can accidentally commit private provider traffic.
- Eval cassettes are ignored but still become durable local artifacts.

Fix:

- Store canonical provider request contracts instead of raw bodies.
- Redact or hash prompt/content fields.
- Redact response bodies by default, or keep only approved minimal fixtures.
- Redact response headers, strip control characters, and cap retained field sizes.
- Record live traffic outside tracked paths by default, with an explicit unsafe override for updating checked-in fixtures.
- Add cassette redaction tests for API keys, bearer tokens, database URLs, private keys, multiline/control characters, and oversized bodies.

Why not duplicate:

- P1-90 covers replay correctness because replay matches only method/path.
- P0-5, P1-50, and P1-83 cover validation/event/evidence/provider-failure leak paths.
- P0-1 covers package leakage.
- P2-47 covers readiness command echo.
- This is normal provider HTTP transcript persistence in record mode, including raw response bodies and tracked artifact overwrite.

---

## Updated Final Baseline For Next Loop (After Twelfth Loop)

Current status:

- P0-1 through P0-16 remain accepted blocker findings.
- P1-1 through P1-130 remain accepted high-priority findings.
- P2-1 through P2-60 remain accepted medium-priority findings.
- The installable CLI/package lane reported no-new-P0/P1/P2 in the twelfth loop.
- No twelfth-loop agent reported a new P0.

Known finding ranges by loop:

- Initial/early audit findings P0-1 through P0-16, P1-1 through P1-47, and P2-1 through P2-24.
- Fifth-loop findings P1-48 through P1-67.
- Sixth-loop findings P1-68 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.
- Ninth-loop findings P1-94 through P1-103 and P2-29 through P2-36.
- Tenth-loop findings P1-104 through P1-115 and P2-37 through P2-42.
- Eleventh-loop findings P1-116 through P1-124 and P2-43 through P2-49.
- Twelfth-loop findings P1-125 through P1-130 and P2-50 through P2-60.

Any further audit agent must first read this whole file and exclude every finding listed here. The prompt to each agent must explicitly say that P0-1 through P0-16, P1-1 through P1-130, and P2-1 through P2-60 are already-known findings and must not be reported again. Future agents should also receive the concrete "why not duplicate" notes above so they do not rename the same issue under a different title. Because the twelfth loop still found new P1/P2 issues, the audit is not done. Future loops must report only new, non-duplicate findings, or explicitly state no-new-P0/P1/P2 for that lane after checking against this file.

---

## Thirteenth Loop Findings - 2026-05-25

Scope:

- Eight agents were launched with the full baseline exclusion set: P0-1 through P0-16, P1-1 through P1-130, and P2-1 through P2-60.
- Agents were explicitly instructed to read this audit file first, exclude already-known problems, and report only new non-duplicates or no-new-P0/P1/P2.
- Skills applied: SOTA, clean-code, code-quality, anti-slop, code-audit, architecture, test-behavior-not-implementation, security-review, and TypeScript-oriented review practices.
- Context7 documentation lookup was attempted for current Vitest guidance but was blocked by monthly quota. The security/installability lanes used current official docs context where relevant.
- The installability/release/package lane reported no-new-P0/P1/P2 after excluding P0-1, P0-2, P0-3, P0-6, P0-7, P0-8, P1-11, P1-12, P1-32, P1-33, P1-41, P1-49, P1-64, P1-70, P1-77, P2-29, and P2-30.
- No thirteenth-loop agent reported a new P0.

### P1-131: hardlinked files bypass writable path confinement and can overwrite outside-project data

Evidence:

- `src/lib/path-confinement.ts:57` through `src/lib/path-confinement.ts:67` validates writable paths with lexical and `realpath` checks, but it does not reject hardlinked files.
- `src/engine/implementers/apply.ts:12` validates write targets, then writes with `writeFile` at `src/engine/implementers/apply.ts:26`, `src/engine/implementers/apply.ts:41`, `src/engine/implementers/apply.ts:63`, and `src/engine/implementers/apply.ts:67`.
- `src/core/paths-io.ts:109` through `src/core/paths-io.ts:112` validates project paths, then writes with `writeFileSync`.
- `src/lib/fs.ts:42` through `src/lib/fs.ts:45` writes secure files without checking link count or inode aliasing.

Impact:

- A project file can be a hardlink to a sensitive outside-project file on the same filesystem.
- The path passes project confinement checks because its realpath is still under the project tree, but writes mutate the shared inode outside the project.
- This bypasses the intended `allowedPaths` and project confinement guarantee without using symlinks or `..` traversal.

Fix:

- Reject write targets whose existing inode has `nlink > 1`, or write by replacing through a new temp file plus atomic rename after verifying the parent directory.
- Apply the same hardlink policy to patch application, project-file writes, session/config writes, and handoff output writes.
- Add tests that create an outside file hardlinked into the project and assert writes are refused.

Why not duplicate:

- P0-11, P0-12, P1-21, P1-73, P1-124, and P1-127 cover symlink, traversal, and project-root containment paths.
- This is the separate hardlink/inode-alias write bypass.

### P1-132: `.trees` can be a symlink, making worktree create/list/remove operate outside the project

Evidence:

- `src/core/paths.ts:75` through `src/core/paths.ts:76` constructs worktree paths as `<projectDir>/.trees/<slug>`.
- `src/engine/worktree.ts:121` through `src/engine/worktree.ts:125` ignores `.trees` in the dirty check.
- `src/engine/worktree.ts:135` passes the joined path to `git worktree add`.
- `src/engine/worktree.ts:140` through `src/engine/worktree.ts:143` lists worktrees under `.trees`.
- `src/engine/worktree.ts:202` and `src/engine/worktree.ts:250` remove joined `.trees` paths with force.
- `src/cli/commands/start.ts:69` through `src/cli/commands/start.ts:71` exposes this through `start --worktree`.

Impact:

- If `.trees` is a symlink to another directory, worktree creation and cleanup can operate outside the project.
- Cleanup paths are especially risky because force removal can delete directories the user did not intend diptych to manage.

Fix:

- `lstat` `.trees` before use, reject symlinks and non-directories, and verify the canonical worktree root remains under `projectDir`.
- Use a single hardened helper for worktree root creation, listing, and removal.
- Add tests for symlinked `.trees` before create/list/remove.

Why not duplicate:

- P1-128 covers staged-copy exclusion of `.trees`.
- P0-11, P0-12, and P1-127 cover other symlink/traversal write paths.
- This is the worktree lifecycle root itself escaping through `.trees`.

### P1-133: handoff pack writes can escape through symlinked output parents or subdirectories

Evidence:

- `src/engine/handoff/write.ts:126` through `src/engine/handoff/write.ts:127` only checks whether the default output directory exists.
- `src/engine/handoff/write.ts:136` creates the output directory recursively.
- `src/engine/handoff/write.ts:141` uses lexical path confinement.
- `src/engine/handoff/write.ts:145` creates nested directories.
- `src/engine/handoff/write.ts:155` writes pack files.

Impact:

- A symlinked handoff output directory, parent, or nested path can redirect pack writes outside the intended project-owned output tree.
- Handoff packs include source, spec, plan, task, and manifest content; redirected writes can overwrite outside files or leak generated artifacts into attacker-controlled locations.

Fix:

- Resolve and verify every handoff output parent with `lstat` and `realpath`.
- Refuse symlinked output roots and symlinked nested directories.
- Use open/write patterns that do not follow symlinks for newly-created files where supported.
- Add tests for symlinked output root, symlinked nested directories, and custom `--out` paths.

Why not duplicate:

- P0-13 covers arbitrary deletion through handoff overwrite.
- P2-45 covers stale append artifacts in existing output directories.
- P1-23 covers path collision.
- This is the symlinked output-tree write escape.

### P1-134: budget stop-loss is not enforced inside retry and escalation spending

Evidence:

- `docs/CONFIGURATION.md:451` describes `maxBudgetUSD` as a hard cap.
- `docs/CONFIGURATION.md:513` describes budget pause/stop-loss behavior.
- `src/engine/orchestrator/task/loop.ts:188` through `src/engine/orchestrator/task/loop.ts:194` checks the budget after task processing.
- `src/engine/orchestrator/task/step.ts:158` records initial usage, then enters retry handling at `src/engine/orchestrator/task/step.ts:170` through `src/engine/orchestrator/task/step.ts:173`.
- `src/engine/orchestrator/escalation/step.ts:43` records retry usage.
- `src/engine/orchestrator/escalation/escalation.ts:46`, `src/engine/orchestrator/escalation/escalation.ts:62`, `src/engine/orchestrator/escalation/escalation.ts:67`, and `src/engine/orchestrator/escalation/escalation.ts:72` run additional retry/escalation tiers without an intervening budget gate.

Impact:

- A session can cross the configured budget cap during local retries, tier0, tier1, or tier2 escalation before the next outer-loop check pauses execution.
- The documented hard stop-loss can be exceeded by the most expensive recovery path.

Fix:

- Check budget before every retry/escalation call that can spend tokens or money.
- Check again immediately after each usage addition and stop before entering the next tier.
- Add tests that set a small budget and force retry/escalation to prove no additional paid call starts after the cap is reached.

Why not duplicate:

- P2-8 covers planning/final-review budget enforcement timing.
- P1-119 covers cost approval rejection state.
- This is the retry/escalation spending path after task execution has already failed.

### P1-135: retry and escalation calls drop the workflow abort signal

Evidence:

- `src/engine/orchestrator/task/run-implementation.ts:58` through `src/engine/orchestrator/task/run-implementation.ts:64` passes the workflow `signal` into the initial implementer run.
- `src/engine/orchestrator/escalation/local-retries.ts:31` through `src/engine/orchestrator/escalation/local-retries.ts:36` calls the implementer without passing that signal.
- `src/engine/orchestrator/escalation/tier0-intermediate.ts:72` through `src/engine/orchestrator/escalation/tier0-intermediate.ts:76` calls the implementer without passing that signal.
- `src/engine/orchestrator/escalation/tier1-hint.ts:39` through `src/engine/orchestrator/escalation/tier1-hint.ts:43` calls the implementer without passing that signal.
- `src/engine/orchestrator/escalation/escalation.ts:49`, `src/engine/orchestrator/escalation/escalation.ts:65`, and `src/engine/orchestrator/escalation/escalation.ts:70` check abort state only between tiers.

Impact:

- A user abort can stop the initial implementation call, but not an in-flight retry/escalation call.
- Long-running or expensive recovery calls can continue after the workflow has been cancelled.

Fix:

- Thread the same `AbortSignal` through all retry and escalation helper calls.
- Ensure shell/API/agent implementers observe that signal consistently.
- Add tests that abort during local retry, tier0, and tier1 escalation.

Why not duplicate:

- P1-38 covers planner cancellation.
- P1-67 covers backend cancellation behavior when invoked.
- P1-99 covers validation subprocess cancellation.
- P1-104 covers partial API stream success after cancellation.
- This is the orchestrator retry/escalation layer dropping an already-available signal.

### P1-136: review-packet and `diptych explain` re-export raw runtime diagnostics

Evidence:

- `src/engine/orchestrator/evidence/review-packet/build.ts:230` through `src/engine/orchestrator/evidence/review-packet/build.ts:233` copies raw `message`, `error`, `reason`, or `routingReason` from session events into packet events.
- `src/engine/orchestrator/evidence/review-packet/sections.ts:321` through `src/engine/orchestrator/evidence/review-packet/sections.ts:329` stores `task_retry` error text as `lastError`.
- `src/engine/orchestrator/evidence/review-packet/sections.ts:345` through `src/engine/orchestrator/evidence/review-packet/sections.ts:376` carries skipped-task reasons into the review packet.
- `src/engine/orchestrator/evidence/review-packet/sections.ts:380` through `src/engine/orchestrator/evidence/review-packet/sections.ts:385` carries raw warning and budget events into `packet.escalations.warnings`.
- `src/engine/orchestrator/explain/sections.ts:108` through `src/engine/orchestrator/explain/sections.ts:112` emits warning text from review packets or events.
- `src/engine/orchestrator/explain/format.ts:78` through `src/engine/orchestrator/explain/format.ts:85` prints retry errors and skipped reasons.

Impact:

- A customer-facing review packet or `diptych explain --json` can expose raw provider errors, hook messages, recovery failure text, skipped-task reasons, or routing diagnostics.
- Those messages can contain prompts, source snippets, tokens, URLs with credentials, or private operational context.

Fix:

- Sanitize and cap diagnostic fields when building the packet and explain model.
- Store structured codes/statuses plus a short redacted tail.
- Keep raw diagnostics only in explicitly local debug artifacts with restrictive permissions.
- Add tests for retry errors, warning events, skipped reasons, and routing reasons containing common secret formats.

Why not duplicate:

- P1-50 covers validation failure text in evidence/review-packet artifacts.
- P1-83 covers provider/implementer failure text persistence and retry prompting.
- P1-103 covers approval/rejection reasons.
- This is the final review-packet/explain artifact surface for runtime warnings, retries, skipped reasons, recovery messages, and routing diagnostics.

### P1-137: stale legacy auto-approval flags can bypass approval gates on rewind

Evidence:

- `src/core/schemas/config.ts:74` through `src/core/schemas/config.ts:79` keep deprecated `autoApproveSpec` and `autoApprovePlan` alongside v3 `workflow.approve`.
- `src/core/config/load/migrate.ts:38` through `src/core/config/load/migrate.ts:42` preserve legacy flags while deriving v3 approval behavior.
- `src/core/config/runtime/overrides.ts:73` through `src/core/config/runtime/overrides.ts:80` sets `workflow.approve`, but only writes legacy flags when the level is `none`.
- `src/engine/orchestrator/planning/rewind.ts:52` gates spec approval from `config.workflow.autoApproveSpec`.
- `src/engine/orchestrator/planning/rewind.ts:69` gates plan approval from `config.workflow.autoApprovePlan`.

Impact:

- A migrated or edited config can say `workflow.approve: all`, but rewind/regeneration can still skip spec or plan gates when stale legacy flags remain true.
- This undermines the human review guarantee for regenerated artifacts.

Fix:

- Use one canonical approval resolver everywhere, including rewind.
- Clear or normalize legacy flags whenever `workflow.approve` is non-`none`.
- Add regression tests for migrated configs plus `/revise-spec` and `/revise-plan`.

Why not duplicate:

- P1-65 covers untrusted project config reducing approval policy.
- This is internal v2/v3 approval-state drift where a stricter approval setting can be bypassed specifically on rewind paths.

### P1-138: interrupted or failed sessions can be exported as complete HTML reports

Evidence:

- `src/engine/orchestrator/session-lifecycle.ts:30` through `src/engine/orchestrator/session-lifecycle.ts:38` always writes `completedAt: Date.now()` even when the saved status is `interrupted` or `failed`.
- `src/engine/export/collect.ts:61` through `src/engine/export/collect.ts:68` derives `isComplete` from `completedAt !== null`, not from `session.status`.
- `src/engine/export/html-renderer.ts:159` through `src/engine/export/html-renderer.ts:163` renders `Completed ...` and `diptych complete` from that `isComplete` value.
- `src/cli/commands/export.ts:45` through `src/cli/commands/export.ts:46` accepts an explicit session id without checking `status === 'complete'`.
- `docs/CLI-REFERENCE.md:718` documents export as exporting a completed session.

Impact:

- A failed or interrupted run with a saved summary can produce a customer-facing report that says the session completed.
- The report can hide incomplete work and undermine handoff trust.

Fix:

- Only set `completedAt` for `status: 'complete'`, or introduce a separate `endedAt`.
- Derive export completion from `Session.status === 'complete'`.
- Reject explicit interrupted/failed exports by default, or clearly label them as interrupted/failed.
- Add tests for complete, interrupted, and failed sessions.

Why not duplicate:

- P1-79 covers process exit status.
- P2-59 covers corrupt optional export artifacts being silently omitted.
- This is the distinct false-completion claim in persisted session/export semantics.

### P2-61: MCP HTTP server relies on broad Node defaults and lacks explicit local connection guards

Evidence:

- `src/engine/mcp/server.ts:123` creates the HTTP server with `createServer`.
- `src/engine/mcp/server.ts:196` starts listening with `server.listen`.
- The server does not set explicit `headersTimeout`, `requestTimeout`, `keepAliveTimeout`, `maxRequestsPerSocket`, or a local connection cap.
- `src/engine/mcp/server.ts:46` through `src/engine/mcp/server.ts:60` caps body size only while reading the request body.

Impact:

- A local untrusted process can hold connections or send slow requests using broader Node defaults than this endpoint needs.
- Because the server is intended for local MCP control-plane calls, it should have tighter and explicit resource limits.

Fix:

- Set explicit short timeouts and max-request/connection limits appropriate for local MCP usage.
- Add tests that verify timeout and oversized/slow-request behavior where feasible.

Why not duplicate:

- Existing MCP findings cover auth, path, evidence, and request-shape risks.
- This is the local HTTP resource-management hardening gap.

### P2-62: MCP DNS-rebinding guard relies on `Origin` only and unauthenticated `/health` bypasses it

Evidence:

- `src/engine/mcp/server.ts:128` through `src/engine/mcp/server.ts:132` serves `/health` before origin or auth checks.
- `src/engine/mcp/server.ts:135` through `src/engine/mcp/server.ts:140` validates `Origin`, but not `Host`.
- `src/engine/mcp/server.test.ts:139` through `src/engine/mcp/server.test.ts:147` covers unauthenticated health behavior.
- `src/engine/mcp/server.test.ts:170` through `src/engine/mcp/server.test.ts:178` covers origin rejection only.

Impact:

- A browser-origin guard that does not also validate host binding is weaker against DNS rebinding style local-service probes.
- The unauthenticated `/health` route also fingerprints the local service before the guard runs.

Fix:

- Validate `Host` against loopback host/port expectations for browser-reachable routes.
- Move `/health` behind the same local-origin/host policy, or make it opt-in and non-identifying.
- Add Host-header and health-route tests.

Why not duplicate:

- Existing MCP findings cover auth token handling and project resource access.
- This is the DNS-rebinding/local-service fingerprinting hardening gap.

### P2-63: MCP bearer-token verification uses variable-time string equality

Evidence:

- `src/engine/mcp/server.ts:79` through `src/engine/mcp/server.ts:85` parses the bearer token and compares it with `provided === token`.
- `src/engine/mcp/server.test.ts:85` through `src/engine/mcp/server.test.ts:100` covers missing and wrong tokens, but not constant-time comparison.

Impact:

- The token is local and high entropy, so this is not a blocker by itself.
- Still, bearer-token verification should avoid prefix-dependent timing behavior on a local HTTP service that has no throttling policy.

Fix:

- Compare fixed-length token buffers with `crypto.timingSafeEqual` after length checks.
- Add a small unit test around the comparison helper rather than timing behavior.

Why not duplicate:

- Existing MCP auth findings cover presence, transport, and request authorization.
- This is the low-level comparison primitive.

### P2-64: `diptych attach 1` numeric-alias behavior is not protected at the command seam

Evidence:

- `docs/CLI-REFERENCE.md:1491` documents numeric aliases such as `diptych attach 1`.
- `src/cli/commands/attach.ts:77` through `src/cli/commands/attach.ts:88` resolves numeric aliases inside the Commander registration wrapper.
- `src/cli/commands/attach.test.ts:40` through `src/cli/commands/attach.test.ts:48` tests `attachCommand` directly, not the registered command seam.
- Targeted search found `resolveNumericAlias` unit coverage but no `registerAttachCommand` or end-to-end `attach 1` command test.

Impact:

- A documented operator workflow can regress while lower-level unit tests still pass.
- Attach/session selection is a customer-facing control-plane command, so the command seam needs coverage.

Fix:

- Add a CLI-level test that registers the command and runs `diptych attach 1` against a session list.
- Assert numeric alias resolution, missing alias behavior, and explicit session id behavior.

Why not duplicate:

- Existing attach/session findings cover active pointers, stale state, and command behavior gaps.
- This is specifically the documented numeric alias at the registered CLI seam.

### P2-65: `diptych init` overwrite/refusal behavior is not covered

Evidence:

- `docs/CLI-REFERENCE.md:297` and `docs/CLI-REFERENCE.md:327` document `init --reconfigure`.
- `src/cli/commands/init.ts:20` through `src/cli/commands/init.ts:23` refuses existing config unless forced.
- `src/cli/commands/init.ts:26` passes the force/reconfigure option.
- `testing/integration/cli/init-config-roundtrip.test.ts:27` covers first-time init, but targeted search found no command test for "Config already exists" or `init --reconfigure`.

Impact:

- The command that writes project configuration can regress in either direction: refusing legitimate reconfiguration or overwriting existing config unexpectedly.

Fix:

- Add behavior tests for existing config without force, with `--reconfigure`, and with JSON/non-JSON output if supported.
- Assert the existing config file content after each path.

Why not duplicate:

- Existing config findings cover trust boundaries, schema drift, and installability.
- This is the documented init overwrite/refusal command behavior.

### P2-66: continuation and queued interjections can build unbounded next-call prompts

Evidence:

- `src/engine/orchestrator/continuation.ts:53` and `src/engine/orchestrator/continuation.ts:60` accumulate `partialOutput`.
- `src/engine/orchestrator/continuation.ts:17` through `src/engine/orchestrator/continuation.ts:19`, `src/engine/orchestrator/continuation.ts:77`, and `src/engine/orchestrator/continuation.ts:90` embed the accumulated output into the next continuation prompt.
- `src/engine/orchestrator/queue.ts:13` and `src/engine/orchestrator/queue.ts:24` through `src/engine/orchestrator/queue.ts:27` cap queued message count at 50, but not message byte size.
- `src/engine/orchestrator/queue.ts:30` through `src/engine/orchestrator/queue.ts:33` stores raw queued text.
- `src/engine/orchestrator/queue.ts:126` through `src/engine/orchestrator/queue.ts:130` formats all queued messages for the next prompt.
- `src/engine/orchestrator/planning/shared.ts:45` through `src/engine/orchestrator/planning/shared.ts:47` and `src/engine/orchestrator/native-injection.ts:18` through `src/engine/orchestrator/native-injection.ts:21` inject queued text.

Impact:

- Large partial outputs or user interjections can make the next planner/implementer call unexpectedly large and expensive.
- This can cause context exhaustion, poor model behavior, or runaway cost even when queue count is capped.

Fix:

- Cap accumulated continuation output and queued interjection bytes.
- Summarize or truncate with explicit markers before injecting into the next model call.
- Add tests for oversized continuation output and oversized queued interjections.

Why not duplicate:

- P1-6 covers live render behavior.
- P1-8 covers output retention/backpressure.
- P1-68 covers resume transcript size.
- P1-130 covers compaction behavior.
- P2-7 covers drained queue retention.
- This is the live next-call prompt construction path.

### P2-67: legacy migration warnings echo full corrupt event lines to stderr

Evidence:

- `src/core/migration/legacy.ts:63` includes the full non-object event line in a warning.
- `src/core/migration/legacy.ts:69` includes the full corrupt event line in a warning.
- `src/cli/commands/migrate.ts:9` through `src/cli/commands/migrate.ts:10` prints migration warnings with `console.warn`.
- Automatic migration warnings are also printed from normal flows such as `start`, `resume`, and `continue`.

Impact:

- A malformed legacy `events.jsonl` line can contain prompts, validation output, copied source, or secrets.
- Running migration or a command that triggers automatic migration can dump that full line into terminal or CI logs.

Fix:

- Print only line numbers/counts and a redacted, capped preview.
- Keep detailed raw migration diagnostics only in a local 0600 debug file behind an explicit unsafe/debug flag.
- Add tests with corrupt legacy lines containing secret-like strings.

Why not duplicate:

- P0-5 covers validation output through event sinks.
- P1-22 covers malformed IPC/RPC input.
- P2-47 covers readiness command echo.
- P2-49 covers symlinked legacy migration cleanup.
- This is legacy migration stderr output of corrupt persisted event records.

### P2-68: provider model discovery logs unredacted `apiBase` endpoint context

Evidence:

- `src/engine/providers/client.ts:122` accepts configured `apiBase`.
- `src/engine/providers/client.ts:127` through `src/engine/providers/client.ts:128` builds the model-list endpoint from it.
- `src/engine/providers/client.ts:97` logs `fetchModelList(${endpoint})` on non-network failures.
- `src/lib/warn.ts:7` through `src/lib/warn.ts:8` redacts only the error message via `toErrorMessage`, not the context string containing `endpoint`.

Impact:

- If users configure a private proxy endpoint containing URL credentials, tenant tokens, or signed query params, model discovery can leak that endpoint to stderr when response parsing fails.

Fix:

- Redact and cap `warnError` context strings, or pass structured context through the existing secret-redaction path.
- Avoid logging full provider endpoints by default; log provider name and sanitized host only.
- Add tests for `apiBase` values containing credentials and signed query parameters.

Why not duplicate:

- P0-16 covers API-key exfiltration through malicious `apiBase`.
- P1-83 covers provider failure text persistence and retry prompting.
- This is a separate stderr logging path where the error text is redacted but the provider endpoint context is not.

### P2-69: slash command execution uses fuzzy lookup for state-mutating commands

Evidence:

- `src/core/runtime/commands/lookup.ts:26` through `src/core/runtime/commands/lookup.ts:30` falls back from exact lookup to fuzzy lookup.
- `src/core/runtime/commands/dispatch.ts:18` through `src/core/runtime/commands/dispatch.ts:22` uses that lookup for command execution.
- `src/core/runtime/commands/registry.test.ts:75` through `src/core/runtime/commands/registry.test.ts:80` explicitly blesses fuzzy command execution.
- `src/core/runtime/commands/registry.ts:408` defines `/reject-run`.
- `src/core/runtime/commands/registry.ts:448` defines `/yolo`.
- `src/cli/rpc/dispatch.ts:53` routes RPC slash commands through the same executor.

Impact:

- Search UX and command execution are coupled.
- Raw slash/RPC automation can execute a safety-affecting command from a typo, including approval disabling or run rejection.

Fix:

- Require exact name or explicit alias for execution and RPC.
- Keep fuzzy matching only for suggestions, palette search, or tab completion.
- If fuzzy execution remains, add command metadata that disables it for mutating or destructive commands.

Why not duplicate:

- P2-13 covers broad runtime command context shape.
- P1-62 and P1-89 cover `/reject-run` snapshot behavior.
- This is specifically command lookup semantics for executing mutating commands.

### P2-70: runner config rebuild drops planner effort and custom capabilities

Evidence:

- `src/core/schemas/runner-fields.ts:28` through `src/core/schemas/runner-fields.ts:41` allow shell/agent planner `capabilities`.
- `src/core/schemas/runner-fields.ts:49` through `src/core/schemas/runner-fields.ts:55` include generation fields including `model`, `customModels`, `contextLength`, and `effort`.
- `src/core/config/runtime/build-runner.ts:14` through `src/core/config/runtime/build-runner.ts:28` omits `effort` and `capabilities` from `BuildRunnerOpts`.
- `src/core/config/runtime/build-runner.ts:47` through `src/core/config/runtime/build-runner.ts:63` omits `effort` from generation parameter preservation.
- `src/features/runners/config-transforms.ts:15` and `src/core/config/runtime/overrides.ts:50` rebuild runner configs from existing config.

Impact:

- Changing planner model, tool, or command can silently erase reasoning effort and custom wrapper capabilities.
- That can change cost/quality behavior and disable features like images, compaction, or hint escalation.

Fix:

- Round-trip `effort` and shell/agent `capabilities` through `BuildRunnerOpts`, existing-to-opts conversion, generation-parameter resolution, and builder outputs.
- Add CLI and picker regression tests for preserving effort and capabilities.

Why not duplicate:

- Existing config findings cover trust boundaries, schema drift, and missing command coverage.
- This is a concrete runtime config rebuild data-loss path for runner quality/capability settings.

### P2-71: persisted stats include interrupted/failed sessions, but rebuild drops them

Evidence:

- `src/engine/orchestrator/session-lifecycle.ts:41` through `src/engine/orchestrator/session-lifecycle.ts:46` updates stats for any saved summary with a cost breakdown, without checking session status.
- `src/cli/commands/stats.ts:23` through `src/cli/commands/stats.ts:31` rebuilds from session history and skips sessions whose status is not `complete`.
- `src/core/stats/persistence.ts:44` through `src/core/stats/persistence.ts:54` increments aggregate stats for every `updateStats()` input.
- `docs/CLI-REFERENCE.md:655` says rebuild uses completed session summaries.

Impact:

- `diptych stats` can include interrupted or failed runs until `stats --rebuild` is run.
- After rebuild, totals and savings can change, making cost reporting unreliable.

Fix:

- Pass session status into stats updates or call `updateStats()` only for `status: 'complete'`.
- Add a regression test proving live stats and rebuilt stats agree for complete, interrupted, and failed sessions.

Why not duplicate:

- P2-44 covers missing command-level behavior coverage for `stats --rebuild`.
- This is the actual accounting divergence between live stats persistence and rebuild semantics.

### P2-72: speckit handoff omits the constitution actually used by speckit

Evidence:

- `src/engine/orchestrator/planning/speckit.ts:100` through `src/engine/orchestrator/planning/speckit.ts:102` reads the constitution from `.specify/memory/constitution.md`.
- `src/engine/handoff/write.ts:98` through `src/engine/handoff/write.ts:101` reads only project-root `constitution.md`.
- `docs/GETTING-STARTED.md:145` documents speckit constitution checks against `.specify/memory/constitution.md`.
- In this repository, root `constitution.md` is absent while `.specify/memory/constitution.md` exists.

Impact:

- A speckit run can be planned against one constitution, then hand off a pack that omits those rules entirely.
- External agents lose the compliance constraints the workflow was supposed to enforce.

Fix:

- Use the same constitution source for speckit planning and handoff.
- Consider including `constitution-check.json` as handoff context.
- Add a test for a repo with only `.specify/memory/constitution.md`.

Why not duplicate:

- P1-123 covers symlink/escape risk in automatic README/package/constitution reads.
- This is a path/contract mismatch that drops required handoff context, not a symlink issue.

### P2-73: handoff `sourceCommit` is omitted for linked worktrees

Evidence:

- `src/engine/handoff/write.ts:163` calls `tryReadGitHead(projectDir)`.
- `src/engine/handoff/write.ts:182` through `src/engine/handoff/write.ts:188` assumes `.git/HEAD` exists under `projectDir`.
- `src/engine/worktree.ts:151` through `src/engine/worktree.ts:152` treats linked worktree `.git` as a file, not a directory.
- `docs/SUBSYSTEMS.md:70` says the handoff manifest includes source commit metadata.

Impact:

- Handoff packs generated from documented `start --worktree` flows can lose the commit identity needed by downstream tools.
- That makes stale-pack detection and source-state reproduction weaker.

Fix:

- Use the git client or `git rev-parse HEAD` for `sourceCommit`, including linked worktrees and packed refs.
- Add a handoff test inside a linked worktree.

Why not duplicate:

- P2-10 is a git-boundary architecture issue.
- This is a concrete handoff manifest correctness failure in the worktree lifecycle.

---

## Updated Final Baseline For Next Loop (After Thirteenth Loop)

Current status:

- P0-1 through P0-16 remain accepted blocker findings.
- P1-1 through P1-138 remain accepted high-priority findings.
- P2-1 through P2-73 remain accepted medium-priority findings.
- The installable CLI/package lane reported no-new-P0/P1/P2 in the thirteenth loop.
- No thirteenth-loop agent reported a new P0.

Known finding ranges by loop:

- Initial/early audit findings P0-1 through P0-16, P1-1 through P1-47, and P2-1 through P2-24.
- Fifth-loop findings P1-48 through P1-67.
- Sixth-loop findings P1-68 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.
- Ninth-loop findings P1-94 through P1-103 and P2-29 through P2-36.
- Tenth-loop findings P1-104 through P1-115 and P2-37 through P2-42.
- Eleventh-loop findings P1-116 through P1-124 and P2-43 through P2-49.
- Twelfth-loop findings P1-125 through P1-130 and P2-50 through P2-60.
- Thirteenth-loop findings P1-131 through P1-138 and P2-61 through P2-73.

Any further audit agent must first read this whole file and exclude every finding listed here. The prompt to each agent must explicitly say that P0-1 through P0-16, P1-1 through P1-138, and P2-1 through P2-73 are already-known findings and must not be reported again. Future agents should also receive the concrete "why not duplicate" notes above so they do not rename the same issue under a different title. Because the thirteenth loop still found new P1/P2 issues, the audit is not done. Future loops must report only new, non-duplicate findings, or explicitly state no-new-P0/P1/P2 for that lane after checking against this file.

---

## Fourteenth Loop Findings - 2026-05-25

Scope:

- Eight agents were launched with the full baseline exclusion set: P0-1 through P0-16, P1-1 through P1-138, and P2-1 through P2-73.
- Agents were explicitly instructed to read this audit file first, exclude already-known problems, and report only new non-duplicates or no-new-P0/P1/P2.
- Skills applied: SOTA, clean-code, code-quality, anti-slop, code-audit, architecture, test-behavior-not-implementation, security-review, and TypeScript expert review.
- Context7 documentation lookup was attempted for Vitest 4 guidance but was blocked by monthly quota.
- Fresh source context was checked for Node HTTP/timeouts, npm package metadata/installability, MCP security/authorization, and Vitest 4 testing/mocking/parallelism.
- The clean-code/architecture/anti-slop lane reported no-new-P0/P1/P2 after checking project invariants, import boundaries, cycles, classes, barrels, memoization, TODO/FIXME, and unsafe-cast signals. It also ran `npm run typecheck:src` and `npm run lint`, both passing.
- No fourteenth-loop agent reported a new P0.

### P1-139: profile-based task routing can ignore CLI implementer/model overrides

Evidence:

- `src/cli/build-overrides.ts:4` through `src/cli/build-overrides.ts:15` maps `--provider`, `--model`, and implementer flags into runtime implementer overrides.
- `src/core/config/runtime/overrides.ts:93` through `src/core/config/runtime/overrides.ts:99` updates only `config.implementer`.
- `src/core/config/accessors/implementer-profiles.ts:54` through `src/core/config/accessors/implementer-profiles.ts:62` resolves from `config.implementerProfiles` when profiles are present.
- `src/engine/orchestrator/task/loop.ts:79` resolves profiles once, `src/engine/orchestrator/task/loop.ts:127` routes tasks through those profiles, and `src/engine/orchestrator/task/loop.ts:145` creates the selected profile implementer.
- Targeted test search found no behavior coverage for implementer-profile configs plus CLI implementer overrides in the command/headless/RPC seams.

Impact:

- A user can run `diptych start/resume/continue --provider ollama --model qwen-local` expecting to force a cheaper/local implementer.
- In a profile-enabled project, the task loop can still route to a configured profile, including a cloud or direct-write profile.
- That breaks a customer-visible cost, privacy, and safety invariant: explicit per-invocation runner overrides should control the runner used for that invocation.

Fix:

- Define one canonical behavior for CLI implementer overrides with profiles.
- Either disable profile routing for that run, or synthesize/replace the runtime default profile from the override.
- Add behavior tests through public start/headless/RPC or task-loop seams with `implementerProfiles`, then assert emitted task metadata and the created implementer use the overridden provider/model.

Why not duplicate:

- P2-15 is provider help/docs drift.
- P2-22 is `doctor` not preflighting the real override invocation.
- P1-65 is untrusted config downgrading approval.
- P2-70 is runner rebuild dropping `effort`/`capabilities`.
- P0-16 is credential exfiltration through malicious `apiBase`.
- This is profile routing overriding an explicit runtime implementer choice.

### P1-140: `WorkflowStateSchema` accepts impossible task indexes that can complete a resumed run without implementation

Evidence:

- `src/core/schemas/workflow.ts:30` through `src/core/schemas/workflow.ts:35` accepts `currentTaskIndex` and `attempt` as plain numbers.
- `src/core/state/persistence.ts:20` through `src/core/state/persistence.ts:26` loads persisted `state.json` through schema parsing.
- `src/cli/commands/resume.ts:36` and `src/cli/commands/continue.ts:119` resume loaded state without index invariant checks.
- `src/engine/orchestrator/task/loop.ts:88` starts the task loop from `state.currentTaskIndex`.
- `src/engine/orchestrator/task/loop.ts:198` returns `complete` after the loop exits.
- `src/engine/orchestrator/run/phases.ts:268` through `src/engine/orchestrator/run/phases.ts:281` proceeds to final review when task status is complete.
- `src/engine/orchestrator/run/run.ts:102` through `src/engine/orchestrator/run/run.ts:103` saves the session as complete when the task run reports complete.

Impact:

- A corrupt or tampered `state.json` with `phase: "implementing"` and a negative, fractional, or beyond-end `currentTaskIndex` can satisfy the schema while violating runtime state-machine invariants.
- Resume/continue can skip pending work and emit a completed workflow.

Fix:

- Constrain persisted workflow state with integer/nonnegative checks.
- Add cross-field validation for `currentTaskIndex <= tasks.length`, phase/task-status coherence, and nonnegative integer attempts.
- Reject invalid persisted state before orchestration.
- Add resume/continue regression tests for corrupt indexes and phase/task mismatches.

Why not duplicate:

- P1-79 covers runtime failures becoming process success.
- P1-117 covers recovery phase drift.
- P1-138 covers failed/interrupted sessions exported as complete.
- P1-96, P1-26, and P1-105 cover different state persistence/privacy surfaces.
- This is a persisted runtime-contract hole that can drive a false complete run.

### P1-141: `diptych spec` creates plan artifacts that documented handoff cannot export

Evidence:

- `docs/CLI-REFERENCE.md:174` says `diptych spec` produces `spec.md`, `plan.md`, and `tasks.md` and is useful for bootstrapping a Handoff Pack.
- `docs/CLI-REFERENCE.md:213` through `docs/CLI-REFERENCE.md:216` points from `diptych spec` to `diptych handoff`.
- `docs/USAGE-EXAMPLES.md:786` through `docs/USAGE-EXAMPLES.md:789` documents `diptych spec "add JWT auth"` followed by `diptych handoff claude-code`.
- `src/cli/commands/spec.ts:40` starts a session and `src/cli/commands/spec.ts:62` through `src/cli/commands/spec.ts:64` writes planner artifacts.
- Targeted search in the spec command found no `state.json` persistence.
- `src/engine/handoff/write.ts:63` through `src/engine/handoff/write.ts:66` requires `loadState()` to succeed.
- `src/cli/session-resolve.ts:4` through `src/cli/session-resolve.ts:7` resolves handoff to the active session when no explicit session is passed.

Impact:

- The documented `diptych spec -> diptych handoff` customer flow can fail because `spec` writes the active pointer and artifacts, but no `state.json`.
- Handoff then resolves the active session and rejects it as missing state.

Fix:

- Persist a minimal `WorkflowState` from `diptych spec`, or allow handoff to fall back to spec/plan/tasks artifacts when state is absent.
- Add a command-level behavior test for `spec` followed by `handoff`.

Why not duplicate:

- P2-35 is broad missing behavior coverage for `diptych spec`.
- P1-13 is broad handoff readback coverage.
- This is the concrete broken documented workflow contract between `spec` and `handoff`.

### P1-142: final review failure still emits workflow completion and saves a complete session

Evidence:

- `docs/WORKFLOW.md:375` through `docs/WORKFLOW.md:379` present final review as the transition from final implementation to complete.
- `src/engine/orchestrator/final-review.ts:81` through `src/engine/orchestrator/final-review.ts:94` catches final planner-review failure and marks `reviewStatus = 'failed'`.
- `src/engine/orchestrator/final-review.ts:106` through `src/engine/orchestrator/final-review.ts:108` still transitions with `REVIEW_DONE`, publishes planner done, and emits `workflow_complete`.
- `src/engine/orchestrator/run/phases.ts:275` through `src/engine/orchestrator/run/phases.ts:281` returns `completed: true` after final review phase.
- `src/engine/orchestrator/run/run.ts:102` through `src/engine/orchestrator/run/run.ts:103` saves `sessionStatus = 'complete'`.
- `src/engine/orchestrator/final-review.test.ts:131` through `src/engine/orchestrator/final-review.test.ts:173` explicitly asserts that final-review planner failure still advances to completion and calls `onComplete`.

Impact:

- A final planner-review failure can still produce workflow completion events and `status: complete`.
- Customer-facing readiness signals can say the work is done when the final gate never succeeded.

Fix:

- Decide whether final review is mandatory or advisory.
- If mandatory, return failed/interrupted and preserve recovery state.
- If advisory, stop using normal completion semantics and expose `finalReviewStatus: failed` consistently in status, export, handoff, hooks, and summaries.

Why not duplicate:

- P1-79 covers runtime failures becoming process success.
- P1-138 covers failed/interrupted sessions exported as complete.
- This path records the session itself as complete after catching final-review failure internally.

### P1-143: handoff packs omit task status and instruct external agents to redo terminal tasks

Evidence:

- `src/core/schemas/task.ts:74` through `src/core/schemas/task.ts:75` defines task status as part of the task contract.
- `src/engine/handoff/write.ts:103` through `src/engine/handoff/write.ts:110` exports selected tasks directly from workflow state.
- `src/engine/handoff/renderers/shared.ts:33` through `src/engine/handoff/renderers/shared.ts:79` renders task briefs without status frontmatter/body.
- `src/engine/handoff/renderers/shared.ts:89` through `src/engine/handoff/renderers/shared.ts:94` tells external agents to work through tasks in dependency order.
- `src/engine/handoff/manifest.ts:40` through `src/engine/handoff/manifest.ts:47` records task ids, but not task statuses.
- `docs/SLASH-COMMANDS-REFERENCE.md:207` through `docs/SLASH-COMMANDS-REFERENCE.md:216` describes `/handoff` as exporting the active session.
- `docs/CLI-REFERENCE.md:817` describes handoff as artifacts for an external coding agent.

Impact:

- Handoff from an in-progress, failed, skipped, or completed session can tell the receiving agent to work through all exported tasks as if they are pending.
- External agents lose the lifecycle signal needed to continue, reproduce, or safely skip terminal tasks.

Fix:

- Include per-task status in task brief frontmatter/body and `manifest.json`.
- Default exports to actionable tasks, or require an explicit include-completed policy.
- Test mixed-status session exports for every renderer.

Why not duplicate:

- P1-13 covers placeholder/hash readback gaps.
- P2-53 covers selected-task dependency closure.
- P2-23 covers validation metadata drift.
- This is specifically loss of task lifecycle status in customer handoff artifacts.

### P1-144: detached crash lockfiles are classified as clean exits

Evidence:

- `src/engine/ipc/lockfile.ts:64` through `src/engine/ipc/lockfile.ts:73` records `markCrashed()` with `signal`, optional `cause`, and `exitedAt`.
- `src/engine/ipc/lockfile.ts:122` through `src/engine/ipc/lockfile.ts:123` classifies any lockfile with `exitedAt` as `{ crashed: false }`.
- `src/engine/ipc/crash-diagnostic.ts:62` through `src/engine/ipc/crash-diagnostic.ts:63` derives the displayed diagnostic status from that boolean.
- `src/engine/ipc/crash-diagnostic.ts:88` through `src/engine/ipc/crash-diagnostic.ts:110` labels non-crashed diagnostics as `EXITED CLEANLY` and only prints log tail for `crashed`.
- `src/engine/ipc/server-entry.ts:207` through `src/engine/ipc/server-entry.ts:208` routes detached server entry failures through `markCrashed()`.
- `src/engine/ipc/spawn-server.ts:71` through `src/engine/ipc/spawn-server.ts:80` polls status until timeout instead of surfacing the recorded crash.

Impact:

- Detached startup/runtime failures can be reported as clean exits or generic startup timeouts.
- Users lose the actual crash signal, cause, and log tail.
- The detached control-plane lifecycle becomes untrustworthy during recovery.

Fix:

- Classify lockfiles with `signal` or `cause` from `markCrashed()` as crashed even when `exitedAt` is present.
- Preserve clean exits only for `markExited()` or expected signal shutdown.
- Add tests for `markCrashed() -> checkServerStatus()`, `ps`, `attach`, `continue`, and startup failure.

Why not duplicate:

- P1-88 covers crashed-session diagnostic flow exiting incorrectly.
- P1-79 covers workflow failure exit status.
- P2-25 covers heartbeat racing clean exit metadata.
- This is the lockfile status classifier making recorded crashes look clean.

### P2-74: npm registry metadata omits support and source-of-truth links

Evidence:

- `package.json:1` through `package.json:89` defines package name, version, description, keywords, license, bin, scripts, dependencies, peer dependencies, and optional dependencies.
- Targeted search found no `repository`, `bugs`, `homepage`, `author`, or `funding` fields in `package.json`.
- `npm pack --dry-run --json --ignore-scripts` includes `package.json`, so the published package would carry this missing metadata.
- npm package metadata docs describe `homepage`, `bugs`, and `repository`; `bugs.url` is used by `npm bugs`.

Impact:

- A customer installing or evaluating the CLI from npm has no registry-level issue tracker, homepage, source repository, maintainer, or support path.
- This weakens handoff readiness, vulnerability reporting, and support for a Claude Code-style installable CLI.

Fix:

- Add npm metadata before publish: `repository`, `bugs.url`, `homepage`, `author` or clear maintainer metadata, and optionally `funding`.
- Include metadata checks in the release/package validation gate.

Why not duplicate:

- P1-11 covers declaring MIT without a packaged LICENSE file.
- P1-12 covers docs/package behavior drift.
- P1-49 covers the documented package name not being published.
- P1-77 covers missing release workflow gates.
- This is specifically missing npm registry support/source metadata after the package exists.

### P2-75: workflow/security config subobjects silently strip misspelled keys

Evidence:

- `src/core/schemas/config.ts:34`, `src/core/schemas/config.ts:65`, and `src/core/schemas/config.ts:81` define non-strict Zod objects for security/workflow-relevant config blocks.
- `src/core/config/load/validate.ts:169` through `src/core/config/load/validate.ts:170` parses with `ConfigSchema.safeParse`.
- `src/core/config/load/load.ts:79` through `src/core/config/load/load.ts:83` merges defaults into `validation` and `workflow`.
- Zod object parsing strips unknown keys by default, so a misspelled nested key can be erased while defaults remain active.

Impact:

- Users can believe they disabled transcript persistence, set budget controls, changed approval behavior, or configured validation/session behavior.
- A misspelled nested key can be silently dropped and the default can remain active.

Fix:

- Make workflow/security-sensitive config subobjects strict, or add an unknown-key detector before Zod stripping.
- At minimum, error or warn for unknown nested keys under `workflow`, `validation`, `approval`, `sessions`, `snapshots`, and `escalation`.
- Add tests for misspelled privacy, budget, approval, and validation keys.

Why not duplicate:

- P2-24 covers malformed whole-config fallback.
- P1-25 covers transcript persistence semantics after a valid flag.
- P1-65 covers untrusted project config lowering approvals.
- P1-137 covers legacy approval flags.
- This is specifically silent erasure of misspelled nested config keys.

### P2-76: auto-discovered TypeScript module hooks are not guaranteed runtime-loadable in the installed CLI

Evidence:

- `docs/HOOKS-CONFIG.md:78` documents module hooks as JS/TS loaded by dynamic import.
- `docs/HOOKS-CONFIG.md:128` through `docs/HOOKS-CONFIG.md:130` documents auto-discovered JS/TS module hooks under `.diptych/hooks/`.
- `src/engine/hooks/discover.ts:35` through `src/engine/hooks/discover.ts:37` discovers `.ts` hooks.
- `src/engine/hooks/load-module.ts:13` through `src/engine/hooks/load-module.ts:18` loads modules with bare ESM `import(url)`.
- `src/engine/hooks/discover.test.ts:41` through `src/engine/hooks/discover.test.ts:46` proves `.ts` discovery.
- `src/engine/hooks/discover.test.ts:103` through `src/engine/hooks/discover.test.ts:106` exercises an executable discovered `.js` hook, not a runtime `.ts` hook.

Impact:

- A user following the documented `.ts` hook path can write ordinary TypeScript that discovers successfully but fails at runtime under installed Node execution.
- Expected hook enforcement can fail depending on hook failure policy.

Fix:

- Either document hooks as JavaScript plus "runtime-loadable TypeScript only", or provide a deliberate transpilation/loader path.
- Add an installed-runtime test for `.ts` module hooks with representative TypeScript syntax, or assert a clear failure message.

Why not duplicate:

- P0-4 covers hook trust enforcement.
- P1-56 and P1-135 cover hook lifecycle/cancellation concerns.
- P0-10 covers custom renderer trust.
- P1-9 and P1-10 cover broad invariant gates.
- This is the specific runtime import contract for documented `.ts` module hooks.

### P2-77: crash diagnostics reprint raw detached `server.log` and crash cause to stdout

Evidence:

- `src/engine/ipc/crash-diagnostic.ts:60` reads the lockfile `cause`.
- `src/engine/ipc/crash-diagnostic.ts:65` through `src/engine/ipc/crash-diagnostic.ts:78` reads and stores the last lines of `server.log`.
- `src/engine/ipc/crash-diagnostic.ts:108` prints the raw cause.
- `src/engine/ipc/crash-diagnostic.ts:110` through `src/engine/ipc/crash-diagnostic.ts:118` prints raw log tail lines.
- `src/engine/ipc/crash-diagnostic.ts:151` through `src/engine/ipc/crash-diagnostic.ts:153` writes the formatted diagnostic to stdout.

Impact:

- After a detached server crash, `diptych attach` or `diptych continue` can dump raw server stderr/log tail and lockfile cause into terminal or CI logs.
- Those lines can include provider errors, URLs, tokens, command output, prompts, local paths, or source snippets.

Fix:

- Redact `cause` and `logTail` with the shared secret redactor.
- Cap line length, strip control characters, and default to showing log path plus metadata.
- Keep raw tail behind an explicit local debug flag.
- Add regression tests with bearer tokens, URL credentials, and private-key-like text in `server.log`.

Why not duplicate:

- P1-88 covers crashed-session resume/control behavior.
- P1-21 covers session path/file hardening.
- P1-83 and P1-136 cover provider/event/review/explain diagnostic surfaces.
- P2-67 and P2-68 cover specific warning/error paths.
- This is the separate crash-diagnostic stdout re-export surface.

### P2-78: speckit analysis artifacts persist arbitrary planner review text without redaction or caps

Evidence:

- `src/engine/orchestrator/planning/speckit.ts:57` through `src/engine/orchestrator/planning/speckit.ts:73` parses planner-supplied constitution `principle`, `reason`, and `severity`.
- `src/engine/orchestrator/planning/speckit.ts:76` through `src/engine/orchestrator/planning/speckit.ts:96` parses planner-supplied `orphanTasks`, `unaddressedSpecSections`, and `warnings`.
- `src/engine/orchestrator/planning/speckit.ts:136` through `src/engine/orchestrator/planning/speckit.ts:141` writes `constitution-check.json`.
- `src/engine/orchestrator/planning/speckit.ts:167` through `src/engine/orchestrator/planning/speckit.ts:171` writes `analyze.json`.

Impact:

- Speckit stores planner-supplied review text directly into durable session artifacts.
- A planner can quote prompt, source, API-key-like strings, or private local context from spec, plan, tasks, or constitution into artifacts users may later share or hand off as diagnostics.

Fix:

- Store structured IDs/counts/statuses by default.
- Redact and length-cap any human-readable snippets.
- Add tests for planner review outputs containing common secret formats.

Why not duplicate:

- P2-72 is about omitting the constitution from handoff.
- P1-123 is about symlinked automatic context reads.
- P1-136 is review-packet/explain re-export.
- P1-83 is provider/implementer failure persistence.
- This is speckit-specific durable planner-review artifact persistence.

### P2-79: cost approval presents prompt-only estimates as total cost/savings

Evidence:

- `src/engine/orchestrator/budget/estimate.ts:84` through `src/engine/orchestrator/budget/estimate.ts:90` defines prompt-only cost estimation.
- `src/engine/orchestrator/budget/estimate.ts:135` through `src/engine/orchestrator/budget/estimate.ts:145` uses prompt-token estimates for implementer and hypothetical planner costs.
- `src/engine/orchestrator/budget/estimate.ts:163` through `src/engine/orchestrator/budget/estimate.ts:188` totals those estimates as actual/hypothetical cost inputs.
- `src/engine/orchestrator/run/phases.ts:178` through `src/engine/orchestrator/run/phases.ts:180` builds the prediction before task execution.
- `src/features/workflow/components/cost-approval-prompt.tsx:41` through `src/features/workflow/components/cost-approval-prompt.tsx:45` presents the value as `Est.` cost.

Impact:

- Pre-task approval can understate spend because completion/output tokens are excluded.
- The UI presents estimate and savings as customer-facing cost numbers.

Fix:

- Include conservative expected output-token estimates per role/task.
- Or label the fields as prompt-only context estimates and keep total cost unknown.
- Add tests where output pricing dominates input pricing.

Why not duplicate:

- P1-134 covers retry/escalation stop-loss enforcement.
- P2-71 covers stats rebuild divergence.
- This is the pre-approval estimate semantics shown to users.

### P2-80: `snapshot diff` has no explicit timeout/output cap and falls back to whole-file diffs

Evidence:

- `src/cli/commands/snapshot.ts:149` through `src/cli/commands/snapshot.ts:152` exposes the recovery-review command.
- `src/engine/snapshots/diff.ts:46` through `src/engine/snapshots/diff.ts:52` builds a manual whole-file two-pass diff.
- `src/engine/snapshots/diff.ts:64` through `src/engine/snapshots/diff.ts:67` reads both whole files for fallback diffing.
- `src/engine/snapshots/diff.ts:75` through `src/engine/snapshots/diff.ts:82` runs `diff` without an explicit timeout/output cap in this layer.
- `src/engine/snapshots/diff.ts:171` begins formatting every changed file.
- `src/engine/orchestrator/evidence/review-packet/build.ts:50` recommends `diptych snapshot diff SNAPSHOT_ID` before restore.

Impact:

- The recommended recovery-review command can hang, hit Node `execFile` buffer limits, then allocate larger fallback strings for large changed files or binaries.

Fix:

- Run diff with explicit timeout and max output, or stream bounded output.
- Detect binary/large files.
- Cap per-file lines/bytes with truncation summaries.
- Add large-file and binary-file tests.

Why not duplicate:

- P1-20 covers snapshot create/hash/copy cost.
- P1-40 covers planner git-diff payload growth.
- P2-37 covers TUI rendering already-computed diffs.
- P1-19 covers extracted-code diffing.
- This is the public snapshot recovery diff path.

### P2-81: `diptych explain` materializes the full session event log before reducing it

Evidence:

- `src/engine/orchestrator/explain/artifacts.ts:65` through `src/engine/orchestrator/explain/artifacts.ts:70` reads explain inputs, including events.
- `src/engine/orchestrator/explain/artifacts.ts:138` through `src/engine/orchestrator/explain/artifacts.ts:142` pushes every session event into an array.
- `src/engine/orchestrator/explain/explain.ts:12` through `src/engine/orchestrator/explain/explain.ts:15` passes the materialized events into explanation builders.
- `src/engine/orchestrator/explain/routing.ts:25` through `src/engine/orchestrator/explain/routing.ts:27` iterates events for routing summaries.
- `src/engine/orchestrator/explain/sections.ts:75` through `src/engine/orchestrator/explain/sections.ts:76` filters events for task-review summaries.

Impact:

- Long handoff sessions with streaming, retries, validation, and warnings can make `diptych explain` allocate the entire log even though it only needs aggregates and tails.

Fix:

- Replace full materialization with a streaming reducer that keeps bounded maps/counters and capped warning/retry tails.
- Prefer summary/review-packet data before scanning raw events.
- Add a large-log regression test.

Why not duplicate:

- P2-56 is review-packet event accumulation.
- P1-136 is diagnostic exposure.
- P2-54 and P1-87 cover TUI/session-history paths.
- This is the explain command's own aggregation path.

### P2-82: MCP HTTP auth rejection omits standard auth challenge/discovery metadata

Evidence:

- `src/engine/mcp/server.ts:88` through `src/engine/mcp/server.ts:90` sends a bare `401` with no `WWW-Authenticate`.
- `src/engine/mcp/server.ts:142` through `src/engine/mcp/server.ts:145` routes auth failures through that response.
- `src/engine/mcp/server.ts:190` through `src/engine/mcp/server.ts:191` returns 404 for every non-`/mcp`/`/health` path; no protected-resource metadata endpoint exists.
- `src/cli/commands/mcp.ts:85` through `src/cli/commands/mcp.ts:100` relies on manually copying a Bearer token into client config.
- `src/engine/mcp/server.test.ts:86` through `src/engine/mcp/server.test.ts:113` asserts only the 401 status.

Impact:

- Spec-following MCP clients cannot discover how to recover from auth failure or distinguish intentional static local-token mode from incomplete auth.
- It also makes later scoped-token or rotation work harder.

Fix:

- For static local-token mode, return a safe Bearer challenge on 401 and test it.
- If Diptych intends MCP OAuth compatibility, add OAuth Protected Resource Metadata and document/serve the auth mode explicitly.

Why not duplicate:

- P1-125 covers missing MCP token scopes.
- P2-50 covers token distribution via project config.
- P2-63 covers variable-time token comparison.
- P2-62 covers Host/health DNS-rebinding hardening.
- This is the missing auth challenge/discovery contract.

### P2-83: corrupt session directory names can break attach/detach/alias control-plane scans

Evidence:

- `src/core/paths.ts:22` through `src/core/paths.ts:34` throws for invalid session IDs.
- `src/cli/sessions/single-running-session.ts:21` through `src/cli/sessions/single-running-session.ts:27` scans every session directory and calls `sessionDir()` without skipping invalid names.
- `src/cli/session-aliases.ts:32` through `src/cli/session-aliases.ts:40` does the same for numeric aliases.
- `src/cli/commands/last.ts:16` through `src/cli/commands/last.ts:24` depends on `buildAliasedSessions()`.
- `src/cli/commands/continue.ts:53` through `src/cli/commands/continue.ts:72` depends on alias and single-running-session scans.

Impact:

- One stale or manually-created invalid directory under `.diptych/sessions` can make `last`, numeric aliases, and no-argument attach/detach/continue fail even when valid sessions exist.

Fix:

- Validate names per entry when scanning session directories.
- Skip invalid directories with a warning, and optionally quarantine them.
- Add regression tests with one valid session plus invalid session directory names.

Why not duplicate:

- P2-34 covers malformed `.diptych/active`.
- P1-81 covers alias data coming only from lockfiles and ignoring normal sessions.
- P2-64 covers `attach 1` command-seam coverage.
- This is corrupt directory scan failure in attach/detach/alias discovery.

---

## Updated Final Baseline For Next Loop (After Fourteenth Loop)

Current status:

- P0-1 through P0-16 remain accepted blocker findings.
- P1-1 through P1-144 remain accepted high-priority findings.
- P2-1 through P2-83 remain accepted medium-priority findings.
- The clean-code/architecture/anti-slop lane reported no-new-P0/P1/P2 in the fourteenth loop.
- No fourteenth-loop agent reported a new P0.

Known finding ranges by loop:

- Initial/early audit findings P0-1 through P0-16, P1-1 through P1-47, and P2-1 through P2-24.
- Fifth-loop findings P1-48 through P1-67.
- Sixth-loop findings P1-68 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.
- Ninth-loop findings P1-94 through P1-103 and P2-29 through P2-36.
- Tenth-loop findings P1-104 through P1-115 and P2-37 through P2-42.
- Eleventh-loop findings P1-116 through P1-124 and P2-43 through P2-49.
- Twelfth-loop findings P1-125 through P1-130 and P2-50 through P2-60.
- Thirteenth-loop findings P1-131 through P1-138 and P2-61 through P2-73.
- Fourteenth-loop findings P1-139 through P1-144 and P2-74 through P2-83.

Any further audit agent must first read this whole file and exclude every finding listed here. The prompt to each agent must explicitly say that P0-1 through P0-16, P1-1 through P1-144, and P2-1 through P2-83 are already-known findings and must not be reported again. Future agents should also receive the concrete "why not duplicate" notes above so they do not rename the same issue under a different title. Because the fourteenth loop still found new P1/P2 issues, the audit is not done. Future loops must report only new, non-duplicate findings, or explicitly state no-new-P0/P1/P2 for that lane after checking against this file.

---

## Fifteenth Loop Findings - 2026-05-25

Scope:

- Re-ran a broad SOTA-oriented audit across TUI/terminal, provider/API networking, persistence/cache, runtime command/RPC, hooks/snapshots/approval safety, installability/release, clean-code/architecture, and docs/contracts.
- Applied `sota`, `clean-code`, `anti-slop`, `test-behavior-not-implementation`, `security-review`, `code-audit`, `code-quality`, `architecture`, and `typescript-expert` guidance.
- Gave every agent the exclusion baseline P0-1 through P0-16, P1-1 through P1-144, and P2-1 through P2-83.
- Context7 Vitest lookup was attempted but blocked by the monthly quota. Agents used local code inspection and available primary documentation references.
- Installability/release reported no-new-P0/P1/P2.
- No fifteenth-loop agent reported a new P0.

Convergence note:

This was the final broad-sweep discovery loop by default. Future work should switch to a closure matrix: enumerate surfaces, mark each lane as closed/no-new or linked to an accepted finding, and only open a new finding when it is a materially distinct customer, security, correctness, or performance risk rather than a subcase of an accepted item.

### P1-145: session ID allocation is check-then-create and can merge concurrent starts into one session directory

Evidence:

- `src/core/sessions/lifecycle.ts:41` through `src/core/sessions/lifecycle.ts:47` generates an ID with `findUniqueId()` by checking `existsSync()` before returning.
- `src/core/sessions/lifecycle.ts:58` through `src/core/sessions/lifecycle.ts:62` then creates the session directory and writes the active pointer.
- `src/lib/fs.ts:38` through `src/lib/fs.ts:40` uses recursive `mkdirSync()`, which succeeds if another process already created the same directory.
- `src/cli/commands/start.ts:152` through `src/cli/commands/start.ts:154` follows the same generate-then-create path for detached sessions.

Impact:

- Two starts in the same project at the same millisecond can receive the same session ID.
- Their event logs, summaries, stats, active pointer, and attach/detach control plane can be merged or overwritten.

Fix:

- Allocate by atomically creating the session directory with exclusive semantics, or include enough entropy that collision is not time-derived.
- Add a regression test that forces the same generated timestamp and starts two sessions concurrently.

Why not duplicate:

- P1-11 covers active-session locking around concurrent starts.
- P1-12 covers detached process PID/state races.
- This is the narrower session identity allocation race before lifecycle locking can provide a reliable boundary.

### P1-146: overlay focus bleed can approve or reject pending approval prompts

Evidence:

- `src/layout.tsx:14` through `src/layout.tsx:15` hides inactive screens with `display: none` instead of unmounting them.
- `src/features/workflow/screen.tsx:227` disables only the composer when the overlay is open.
- `src/features/workflow/screen.tsx:260` through `src/features/workflow/screen.tsx:261` leaves `ApprovalPrompt` and `CostApprovalPrompt` mounted.
- `src/features/workflow/components/approval-prompt.tsx:17` and `src/features/workflow/components/approval-prompt.tsx:27` through `src/features/workflow/components/approval-prompt.tsx:48` keep single-key approval handling active while pending.
- `src/features/workflow/components/cost-approval-prompt.tsx:18` through `src/features/workflow/components/cost-approval-prompt.tsx:27` similarly handles `y`, `n`, `return`, and `escape`.

Impact:

- While a command palette or another overlay is open, ordinary navigation or selection keystrokes can approve, reject, or always-allow a pending gate in the hidden workflow screen.
- This is a high-risk safety issue because approvals are security and cost boundaries.

Fix:

- Add a single focus/overlay ownership gate and pass it into approval prompts.
- Ignore approval hotkeys unless the workflow screen owns input focus and no modal overlay is active.
- Add an integration test that opens the palette while an approval is pending and verifies approval state is unchanged after overlay keystrokes.

Why not duplicate:

- P1-93 covers shared approval queues across sessions.
- P1-117 covers silent default allow for cost approval timeout in non-interactive mode.
- This is interactive focus bleed from mounted hidden prompts.

### P1-147: interactive Ink rendering accepts untrusted terminal control sequences

Evidence:

- `src/features/workflow/tui-sink.ts:4` through `src/features/workflow/tui-sink.ts:5` maps workflow events into UI actions without sanitizing text payloads.
- `src/features/workflow/components/event-card.tsx:59` through `src/features/workflow/components/event-card.tsx:60` renders raw planner text through `MarkdownBlock`.
- `src/features/workflow/components/markdown.tsx:87` renders raw or highlighted code text inside Ink `Text`.
- `src/features/workflow/components/streaming-lines.tsx:14` through `src/features/workflow/components/streaming-lines.tsx:17` renders streamed lines directly.
- `src/features/workflow/components/validate-card.tsx:70` through `src/features/workflow/components/validate-card.tsx:72` renders raw validation errors.
- `src/lib/highlight.ts:53` through `src/lib/highlight.ts:57` also emits app-owned ANSI output, so sanitization must distinguish trusted formatting from untrusted model/provider/tool text.

Impact:

- A malicious provider, repository output, or validation command can inject terminal escape sequences into the interactive TUI.
- This can spoof UI state, hide prompt text, alter terminal titles, or poison scrollback while an operator is making approval decisions.

Fix:

- Strip or escape terminal control sequences from all untrusted text before rendering.
- Apply trusted styling only after sanitization.
- Add tests for OSC, CSI, cursor movement, alternate screen, and color reset payloads.

Why not duplicate:

- P1-118 covers OSC/control characters in non-interactive JSON logs.
- P1-119 covers terminal output in validation logs.
- This finding is the interactive Ink rendering path for planner/provider/event text.

### P1-148: OpenAI-compatible malformed stream chunks can be logged raw by SDK before Diptych redaction

Evidence:

- `src/engine/providers/client.ts:62` through `src/engine/providers/client.ts:63` constructs the OpenAI client without overriding `logger`, `logLevel`, or `maxRetries`.
- The local `openai` SDK package defaults to console logging with warning-level output and two retries.
- The local SDK streaming parser logs malformed SSE payloads through its logger before Diptych maps provider errors.
- `src/engine/providers/openai-stream.ts:93` through `src/engine/providers/openai-stream.ts:109` handles errors after the SDK call boundary, so it cannot redact SDK-internal logging that already occurred.

Impact:

- A malformed OpenAI-compatible endpoint can write raw response data to stderr/stdout before Diptych's redaction layer sees it.
- This can leak prompts, provider payloads, keys embedded in error text, or private repository content.

Fix:

- Pass a Diptych-owned SDK logger that redacts and routes logs through the normal diagnostics path.
- Consider disabling SDK logging by default for user-facing CLI runs.
- Add an integration test with a malformed SSE response containing a sentinel secret.

Why not duplicate:

- P1-109 covers Anthropic SDK verbose logging.
- P1-118 covers Diptych JSON log escaping.
- This is OpenAI-compatible SDK-internal malformed-stream logging before Diptych error handling.

### P1-149: `on_failure: block` hooks fail open when command/module is missing

Evidence:

- `src/engine/hooks/dispatch.ts:51` through `src/engine/hooks/dispatch.ts:52` returns a warning when a hook command is missing.
- `src/engine/hooks/dispatch.ts:61` through `src/engine/hooks/dispatch.ts:62` returns a warning when a hook module is missing.
- `src/engine/hooks/run-pre-hook.ts:29` through `src/engine/hooks/run-pre-hook.ts:35` blocks only on explicit deny or crash with `on_failure: block`; warning results proceed.
- `docs/HOOKS-CONFIG.md:304` through `docs/HOOKS-CONFIG.md:305` documents the current fail-open behavior for missing commands.

Impact:

- Teams can believe a blocking security, lint, license, or policy hook is enforced while a typo or missing local dependency silently downgrades it to warning-only.
- This breaks handoff trust because the config says block, but absence of the checker allows execution.

Fix:

- Treat missing command/module as blocking when `on_failure: block`.
- Keep fail-open only for hooks explicitly configured to warn.
- Add tests for missing command and missing module with both block and warn modes.

Why not duplicate:

- P1-121 covers interruption after `pre_validation` changes.
- P2-77 covers hook command resolution drift between start and replay.
- This is fail-open semantics for missing hook executables/modules despite a blocking policy.

### P1-150: blocking `pre_validation` hooks leave applied code in unrecoverable interrupted state

Evidence:

- `src/engine/orchestrator/task/step.ts:191` emits `TASK_SENT` after implementer output has been applied.
- `src/engine/orchestrator/state/machine.ts:206` through `src/engine/orchestrator/state/machine.ts:207` moves into `validating-task`.
- `src/engine/orchestrator/task/step.ts:202` runs `pre_validation`.
- `src/engine/orchestrator/task/step.ts:203` through `src/engine/orchestrator/task/step.ts:205` warns and returns state when the hook interrupts, without validation or recovery.
- `src/engine/orchestrator/task/loop.ts:167` through `src/engine/orchestrator/task/loop.ts:169` stops because the task index did not advance.
- `src/engine/orchestrator/run/run.ts:26` through `src/engine/orchestrator/run/run.ts:27` preserves active state only for pending recovery or rewind.
- `src/engine/orchestrator/session-lifecycle.ts:54` clears active state otherwise.

Impact:

- Code can remain modified after a blocking hook, but the session is not left in a resumable recovery state.
- Users may see a stopped run with applied changes and no validation result, making handoff and rollback ambiguous.

Fix:

- Treat blocking `pre_validation` as a recoverable workflow state.
- Preserve active session metadata and expose a clear resume, rewind, or restore path.
- Add tests for blocking `pre_validation` after implementer changes were applied.

Why not duplicate:

- P1-121 covers `pre_validation` interruption and active-session clearing generally.
- This adds the applied-code lifecycle consequence: the workflow has already emitted and applied the task output but does not enter a recoverable state.

### P1-151: RPC stdin disconnect does not abort workflow or resolve pending gates

Evidence:

- `src/cli/rpc/reader.ts:4` through `src/cli/rpc/reader.ts:9` and `src/cli/rpc/reader.ts:11` through `src/cli/rpc/reader.ts:30` emit line commands and parse errors, but no close/end/error lifecycle callback.
- `src/cli/rpc/run.ts:132` through `src/cli/rpc/run.ts:141` can wait on approval and message gates.
- `src/cli/rpc/run.ts:156` through `src/cli/rpc/run.ts:157` can wait on recovery gates.
- `src/cli/rpc/run.ts:205` through `src/cli/rpc/run.ts:207` aborts only on an explicit RPC command.
- `src/cli/rpc/run.ts:218` through `src/cli/rpc/run.ts:222` wires only command and parse-error callbacks from the reader.
- `src/cli/rpc/gates.ts:5` through `src/cli/rpc/gates.ts:22` has no reject/abort path for transport shutdown.
- `src/cli/rpc/run.test.ts:468` through `src/cli/rpc/run.test.ts:497` closes stdin but manually completes the workflow, so it does not prove fail-closed behavior when a gate is pending.

Impact:

- If the controlling parent process dies or closes stdin while a gate is pending, Diptych can keep running or hang with unresolved approvals.
- In automation, that is a safety and cost boundary failure.

Fix:

- Treat stdin close/end/error as transport cancellation.
- Abort the orchestrator and reject or resolve pending gates deterministically.
- Add tests for stdin close while awaiting approval, cost, message, and recovery gates.

Why not duplicate:

- P1-94 covers RPC approval authorization.
- P1-128 covers RPC transport schema strictness.
- This is lifecycle failure when the RPC control transport disconnects.

### P2-84: concurrent stats updates can lose completed-session cost records

Evidence:

- `src/core/stats/persistence.ts:79` through `src/core/stats/persistence.ts:81` reads current stats, computes accumulated values, then writes.
- `src/core/stats/persistence.ts:31` through `src/core/stats/persistence.ts:33` writes atomically through temp+rename but does not lock the read-modify-write sequence.
- `src/engine/orchestrator/session-lifecycle.ts:40` through `src/engine/orchestrator/session-lifecycle.ts:50` calls `updateStats()` when sessions finish.

Impact:

- Two sessions finishing at nearly the same time can both read the same old stats file and one can overwrite the other's totals.
- Cost dashboards and handoff accounting can under-report actual spend.

Fix:

- Serialize stats updates with a project-level lock, or append immutable session records and aggregate when reading.
- Add a concurrent completion regression test.

Why not duplicate:

- P2-27 covers missing stats for failed sessions.
- P2-74 covers stats cache staleness.
- This is lost update under concurrent successful writes.

### P2-85: repo-map cache can serve stale symbols when content changes with identical mtime and size

Evidence:

- `src/engine/codebase/cache.ts:61` through `src/engine/codebase/cache.ts:66` checks only parser version, file size, and mtime.
- `src/engine/codebase/cache.ts:68` through `src/engine/codebase/cache.ts:74` returns cached symbols/imports when those fields match.

Impact:

- Some filesystems, generated files, or rapid rewrites can change content while preserving size and timestamp granularity.
- Planner context can contain stale imports/symbols even though source content changed.

Fix:

- Include a content hash in the cache key or store a fast checksum for files below a reasonable size threshold.
- Add a test that rewrites a file with same byte length and forced identical mtime.

Why not duplicate:

- P1-111 covers stale repo map across task boundaries.
- P2-66 covers ignored nested package roots.
- This is the per-file cache freshness predicate.

### P2-86: final `summary.json` writes are non-atomic, so a crash can hide completed sessions

Evidence:

- `src/core/sessions/io.ts:44` through `src/core/sessions/io.ts:48` writes `summary.json` directly and then chmods it.
- `src/core/sessions/io.ts:18` through `src/core/sessions/io.ts:33` returns null for malformed or unreadable summaries.
- `src/core/sessions/io.ts:60` through `src/core/sessions/io.ts:64` skips null summaries while listing sessions.

Impact:

- A crash or disk interruption during final summary write can leave a truncated file.
- Completed sessions can disappear from history and aliases even though event logs remain.

Fix:

- Write summaries through temp+fsync+rename, matching the safer write patterns elsewhere.
- Add a regression test with truncated summary data plus a valid event log.

Why not duplicate:

- P1-81 covers lockfile-only alias discovery.
- P2-83 covers invalid session directory names.
- This is non-atomic final summary persistence.

### P2-87: task-review prompt treats unknown input as continue

Evidence:

- `src/cli/task-review-prompt.ts:36` through `src/cli/task-review-prompt.ts:48` maps unknown normalized input to `COMMAND_ALIASES[lower] ?? 'continue'`.
- `src/cli/task-review-prompt.test.ts:71` through `src/cli/task-review-prompt.test.ts:87` covers only known aliases.
- `src/engine/orchestrator/task-review.ts:43` through `src/engine/orchestrator/task-review.ts:47` proceeds when the resolved command is continue.

Impact:

- A typo at a manual review prompt can accept and continue a task instead of asking for correction.
- This is risky in handoff scenarios because review prompts are quality gates.

Fix:

- Re-prompt on unknown input, or require an explicit empty enter for default continue.
- Add tests for arbitrary unknown input.

Why not duplicate:

- P2-41 covers prompt defaults in a different confirmation path.
- P2-76 covers review persistence drift.
- This is unknown manual-review command parsing.

### P2-88: project-configured custom palette actions can disguise safety-affecting slash commands

Evidence:

- `src/cli/config.ts:10` through `src/cli/config.ts:15` accepts custom palette actions with arbitrary labels, descriptions, and slash commands.
- `src/features/palette/sources.ts:131` through `src/features/palette/sources.ts:136` executes the configured command while displaying project-provided label and description.
- `src/features/palette/results.ts:93` through `src/features/palette/results.ts:100` does not expose the raw command in the result model.
- `src/features/palette/overlay.tsx:71` through `src/features/palette/overlay.tsx:78` executes the selected action on enter.
- `src/features/palette/registry.ts:409` through `src/features/palette/registry.ts:420` includes `/reject-run confirm`.
- `src/features/palette/registry.ts:448` through `src/features/palette/registry.ts:462` includes `/yolo`.

Impact:

- A repository can label a dangerous slash command as a harmless action in the palette.
- Operators reviewing an unfamiliar repository can trigger safety-affecting commands based on misleading project-controlled UI text.

Fix:

- Display the raw command for custom actions, especially when the target command changes safety, approval, or run lifecycle state.
- Consider requiring confirmation for custom actions that resolve to high-risk commands.
- Add tests that custom action rendering includes the command.

Why not duplicate:

- P1-126 covers trusted project config modifying command palette behavior broadly.
- This is the specific spoofing vector where label/description hide the real safety-affecting command.

### P2-89: OpenAI-compatible calls inherit SDK auto-retries outside Diptych budget/retry accounting

Evidence:

- The local `openai` SDK client defaults to request retries.
- `src/engine/providers/client.ts:62` through `src/engine/providers/client.ts:63` constructs the client without setting `maxRetries`.
- `src/engine/providers/openai-stream.ts:93` through `src/engine/providers/openai-stream.ts:107` passes only request signal options into the streaming call.

Impact:

- A single Diptych provider call can result in multiple network attempts before Diptych records or controls the retry.
- This can inflate cost, delay cancellation, and make provider failure behavior differ from Diptych's own retry policy.

Fix:

- Set SDK `maxRetries: 0` and centralize retry policy in Diptych, or account for SDK retries explicitly in budgets and diagnostics.
- Add a test with a retrying fake OpenAI-compatible endpoint.

Why not duplicate:

- P2-5 covers budget estimate mismatch.
- P1-148 covers SDK logging of malformed chunks.
- This is retry/cost accounting drift caused by SDK defaults.

### P2-90: `apiKey: env:...` is accepted as configured credentials but sent literally to providers

Evidence:

- `src/cli/config/runner-fields.test.ts:11` through `src/cli/config/runner-fields.test.ts:17` accepts `apiKey` strings including `env:` prefixes.
- `src/cli/config/runner-fields.ts:21` through `src/cli/config/runner-fields.ts:26` models `apiKey` as a plain string.
- `src/cli/config/runner-credentials.ts:27` through `src/cli/config/runner-credentials.ts:29` counts custom-provider `apiKey` as configured credentials.
- `src/engine/providers/client.ts:124` through `src/engine/providers/client.ts:125` returns override `apiKey` literally.
- `src/engine/providers/anthropic/stream.ts:238` through `src/engine/providers/anthropic/stream.ts:242` sends `opts.apiKey` as `x-api-key`.

Impact:

- Users can reasonably configure `apiKey: env:MY_KEY` and pass config validation, but Diptych sends `env:MY_KEY` as the actual credential.
- Provider calls fail confusingly, and logs or diagnostics can expose the intended secret variable name.

Fix:

- Either resolve `env:` references consistently for API keys or reject them with a precise validation error.
- Add tests for custom provider and Anthropic-compatible overrides.

Why not duplicate:

- P1-110 covers environment-variable leakage in provider diagnostics.
- P2-50 covers MCP token distribution.
- This is credential configuration syntax accepted but not resolved.

### P2-91: models.dev pricing and context metadata are trusted without sanity bounds

Evidence:

- `src/engine/models/models-dev.ts:6` through `src/engine/models/models-dev.ts:12` accepts optional numeric pricing/context fields without explicit bounds.
- `src/engine/models/models-dev.ts:27` through `src/engine/models/models-dev.ts:44` copies pricing and context metadata into model records.
- `src/engine/budget/pricing-resolver.ts:108` through `src/engine/budget/pricing-resolver.ts:117` prefers models.dev pricing when available.
- `src/engine/context-length.ts:37` through `src/engine/context-length.ts:40` trusts context length metadata.
- `src/engine/budget/estimate.ts:90` through `src/engine/budget/estimate.ts:92` uses resolved pricing for estimates.

Impact:

- A bad or compromised models metadata file can produce impossible prices or context windows.
- Budget approval and context packing decisions can become misleading even when the rest of the provider path is healthy.

Fix:

- Validate finite, non-negative pricing and plausible context/token bounds.
- Prefer provider-known hard limits when metadata is absent or suspicious.
- Add tests for negative, NaN, huge, and zero values.

Why not duplicate:

- P2-5 covers general budget estimate mismatch.
- P2-89 covers retry accounting drift.
- This is unbounded external model metadata ingestion.

### P2-92: live `continue` / `last` ignore documented `--allow-hooks` before attach

Evidence:

- `docs/CLI-REFERENCE.md:547` documents `diptych continue --allow-hooks`.
- `docs/CLI-REFERENCE.md:609` documents the same option for `last`.
- `docs/CLI-REFERENCE.md:1519` lists `--allow-hooks` as a shared flag.
- `docs/HOOKS-CONFIG.md:336` says CI must pass `--allow-hooks` explicitly.
- `src/cli/options.ts:21` registers the flag.
- `src/cli/commands/continue.ts:96` through `src/cli/commands/continue.ts:99` attaches to an alive session by calling `deps.initStores(opts.projectDir)` without passing options.
- `src/cli/init-stores.ts:23` through `src/cli/init-stores.ts:30` defaults `allowHooks` to false.
- `src/cli/commands/continue.ts:153` passes options only on the interrupted/resume path.

Impact:

- Users can pass a documented hook policy flag while attaching to a live session and still get stores initialized as if hooks are disallowed.
- This creates confusing and potentially unsafe differences between live attach and interrupted resume.

Fix:

- Pass CLI options into live attach store initialization.
- Add coverage for `continue --allow-hooks` and `last --allow-hooks` against an alive session.

Why not duplicate:

- P2-77 covers hook command resolution drift between start and replay.
- P1-149 covers missing blocking hook fail-open.
- This is documented flag propagation being ignored on the live attach path.

### P2-93: validation hook payloads omit documented `file` field

Evidence:

- `docs/HOOKS-CONFIG.md:38` documents `pre_validation` payload fields including `taskId` and `file`.
- `docs/HOOKS-CONFIG.md:195` through `docs/HOOKS-CONFIG.md:196` document `{file}` placeholders.
- `src/engine/orchestrator/task/step.ts:197` through `src/engine/orchestrator/task/step.ts:201` builds the `pre_validation` payload without a `file` field.
- `src/engine/orchestrator/events.ts:61` through `src/engine/orchestrator/events.ts:96` validation events do not carry file data either.

Impact:

- Hook authors following the docs cannot write per-file validation hooks using the documented field.
- Hooks may silently run with missing placeholders or fall back to broader validation than intended.

Fix:

- Either include the documented file data in hook payloads or remove the documented field and placeholders.
- Add tests that assert hook payload shape matches docs.

Why not duplicate:

- P2-65 covers hook documentation drift for command examples.
- P2-92 covers flag propagation for hooks.
- This is payload contract mismatch for validation hook data.

### P2-94: `snapshot restore` leaves files added after snapshot while claiming working-tree restore

Evidence:

- `docs/CLI-REFERENCE.md:976` describes snapshot restore as restoring the working tree to a snapshot, with modified files after the snapshot treated as conflicts.
- `src/core/snapshots/restore.ts:97` loops only over files recorded in the snapshot.
- `src/core/snapshots/restore.ts:140` through `src/core/snapshots/restore.ts:149` restores only those files.
- `src/core/snapshots/diff.ts:102` through `src/core/snapshots/diff.ts:104` compares the union of snapshot and current files.
- `src/core/snapshots/diff.ts:121` through `src/core/snapshots/diff.ts:122` classifies current-only files as added.

Impact:

- Files created after the snapshot remain after restore, even though the command reads like a working-tree rollback.
- Users may believe generated or sensitive files were removed when they were not.

Fix:

- Either delete current-only files during restore with conflict/confirmation handling, or document restore as snapshot-file-only.
- Add tests for files added after snapshot.

Why not duplicate:

- P1-84 covers snapshot restore safety around modified tracked files.
- P2-72 covers snapshot diff display ambiguity.
- This is current-only file retention during restore.

### P2-95: workflow lifecycle projection is split between partial event reduction and store-only mutation

Evidence:

- `docs/STORES-AND-UI.md:48` documents EventBus to TUI sink to stores as the workflow projection path.
- `docs/STORES-AND-UI.md:62` through `docs/STORES-AND-UI.md:63` says lifecycle state owns current phase.
- `src/features/workflow/stores/workflow/lifecycle.ts:33` through `src/features/workflow/stores/workflow/lifecycle.ts:37` derives phase only from `planner_status`.
- `src/features/app/keys.ts:55` through `src/features/app/keys.ts:61` reads `lifecycleStore.phase`.
- `src/features/palette/review-parser.ts:64` through `src/features/palette/review-parser.ts:76` reads `lifecycleStore.phase`.
- `src/features/palette/sources.ts:96` through `src/features/palette/sources.ts:104` reads `lifecycleStore.phase`.
- `src/features/workflow/stores/workflow/actions.ts:53` through `src/features/workflow/stores/workflow/actions.ts:66` creates `workflow_cancelled` directly in the store path.
- `src/features/workflow/otel.ts:54` through `src/features/workflow/otel.ts:68` observes cancellation only when the event reaches the sink.

Impact:

- Some lifecycle transitions are event-sourced and observable, while others are local store mutations.
- Keyboard routing, palette availability, telemetry, and replay can disagree about the actual workflow phase.

Fix:

- Make lifecycle phase a pure projection of workflow events, including cancellation and review states.
- Remove store-only lifecycle transitions or route them back through the event bus.
- Add a replay test that verifies UI phase from an event log.

Why not duplicate:

- P2-60 covers workflow event ordering for telemetry.
- P2-76 covers review persistence.
- This is split lifecycle projection between event reduction and local UI mutation.

---

## Updated Final Baseline For Next Stage (After Fifteenth Loop)

Current status:

- P0-1 through P0-16 remain accepted blocker findings.
- P1-1 through P1-151 remain accepted high-priority findings.
- P2-1 through P2-95 remain accepted medium-priority findings.
- The installability/release lane reported no-new-P0/P1/P2 in the fifteenth loop.
- No fifteenth-loop agent reported a new P0.

Known finding ranges by loop:

- Initial/early audit findings P0-1 through P0-16, P1-1 through P1-47, and P2-1 through P2-24.
- Fifth-loop findings P1-48 through P1-67.
- Sixth-loop findings P1-68 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.
- Ninth-loop findings P1-94 through P1-103 and P2-29 through P2-36.
- Tenth-loop findings P1-104 through P1-115 and P2-37 through P2-42.
- Eleventh-loop findings P1-116 through P1-124 and P2-43 through P2-49.
- Twelfth-loop findings P1-125 through P1-130 and P2-50 through P2-60.
- Thirteenth-loop findings P1-131 through P1-138 and P2-61 through P2-73.
- Fourteenth-loop findings P1-139 through P1-144 and P2-74 through P2-83.
- Fifteenth-loop findings P1-145 through P1-151 and P2-84 through P2-95.

Any further audit or verification agent must first read this whole file and exclude every finding listed here. The prompt to each agent must explicitly say that P0-1 through P0-16, P1-1 through P1-151, and P2-1 through P2-95 are already-known findings and must not be reported again. Future agents should also receive the concrete "why not duplicate" notes above so they do not rename the same issue under a different title.

Future work must not run another broad exploratory loop by default. Use a closure matrix/convergence audit: enumerate surfaces, mark each as closed/no-new or linked to an accepted finding, and only open a new finding when it is a materially distinct customer/security/performance risk, not a subcase of accepted findings. Once the closure matrix is complete, freeze discovery and move to fix planning/execution against the accepted baseline.

---

## Convergence Closure Matrix - 2026-05-25

Purpose:

- Continue the requested deep SOTA audit loop without repeating the same discovery work.
- Close explicit handoff-readiness surfaces one by one.
- Treat all accepted findings as the exclusion baseline: P0-1 through P0-16, P1-1 through P1-151, and P2-1 through P2-95.
- Add a new finding only when it is a materially distinct customer, security, correctness, privacy, installability, or performance risk.

SOTA inputs consulted for this stage:

- Skills: `sota`, `clean-code`, `anti-slop`, `test-behavior-not-implementation`, `security-review`, `code-audit`, `code-quality`, `architecture`, and `typescript-expert`.
- Current primary-source references:
  - Node.js Security Best Practices: local-server DoS timeouts, DNS rebinding, sensitive information exposure in published packages, timing-safe comparison, dependency/supply-chain hardening.
  - npm trusted publishing/provenance docs: OIDC trusted publishing, automatic provenance generation for public packages, and reducing long-lived token risk.
  - MCP authorization docs: `401` with `WWW-Authenticate` and Protected Resource Metadata for OAuth-style protected resources.
  - OWASP Logging Cheat Sheet: no secrets or sensitive data in logs, structured logging, and explicit sanitization of untrusted data.
- Context7 was attempted for Vitest current docs and returned monthly quota exceeded.

Stop rules for closure agents:

- First read this whole file, especially the latest baseline section and every "Why not duplicate" note.
- Do not report P0-1 through P0-16, P1-1 through P1-151, or P2-1 through P2-95 again.
- Do not split an accepted finding into smaller sub-findings.
- Do not report style preferences, hypothetical preferences, or low-value nits.
- Each lane must end with either:
  - `closed/no-new-P0/P1/P2` with evidence of what was checked, or
  - a small number of new material findings with exact evidence and duplicate analysis.
- A lane is closed only if its checks cover source code, tests, docs/contracts, and customer handoff impact for that surface.

Initial closure lanes:

| Lane | Surface | Closure target | Status |
| --- | --- | --- | --- |
| C1 | Localhost, MCP, HTTP, IPC, RPC, DNS-rebinding, transport auth | Local server/control surfaces are either protected by accepted findings or have no additional material exposure | pending |
| C2 | Provider/API, credentials, logs, redaction, model metadata, third-party network calls | No additional secret/cost/privacy leak beyond accepted findings | pending |
| C3 | Filesystem, sessions, snapshots, caches, handoff/export artifacts, symlink/path/race persistence | No additional data-loss, path escape, corruption, or handoff artifact gap beyond accepted findings | pending |
| C4 | Workflow orchestration, approval gates, recovery, cancellation, active session lifecycle | No additional fail-open, stuck, or misleading lifecycle state beyond accepted findings | pending |
| C5 | TUI, command palette, input focus, terminal rendering, accessibility/keyboard behavior | No additional safety-affecting input/rendering flaw beyond accepted findings | pending |
| C6 | Installable CLI, npm packaging, release provenance, dependency/license/runtime supply chain | Packaged CLI can be evaluated against accepted release blockers; no additional material release blocker | pending |
| C7 | Tests, CI gates, invariants, behavior-not-implementation coverage | Missing coverage is either already accepted or no additional customer-risk coverage gap is found | pending |
| C8 | Clean-code, anti-slop, architecture, TypeScript boundaries, performance hotspots | No additional high-value maintainability/performance risk beyond accepted findings | pending |

Agents assigned to these lanes must report against this table. The synthesis step should update each lane to `closed/no-new`, `accepted-new-findings`, or `needs-follow-up` with the precise evidence used.

---

## Convergence Closure Results - 2026-05-25

Summary:

- C1 localhost/MCP/HTTP/IPC/RPC/control-plane: closed/no-new-P0/P1/P2.
- C2 provider/API/credentials/logs/redaction/model metadata: closed/no-new-P0/P1/P2.
- C3 filesystem/sessions/snapshots/caches/handoff/export/persistence: closed/no-new-P0/P1/P2.
- C4 workflow/approvals/recovery/cancellation/lifecycle: accepted one new P2, no-new-P0/P1.
- C5 TUI/palette/input/terminal rendering/keyboard: closed/no-new-P0/P1/P2.
- C6 installable CLI/npm/release/provenance/supply chain: closed/no-new-P0/P1/P2.
- C7 tests/CI/invariants/behavior coverage: closed/no-new-P0/P1/P2.
- C8 clean-code/anti-slop/architecture/TypeScript/performance: closed/no-new-P0/P1/P2.

Verification evidence:

- Local command: `npm run lint` passed; Biome checked 1134 files.
- Local command: `npm run typecheck` passed for source and test TypeScript configs.
- Local command: `npm test` passed 390 test files and 3740 tests.
- C1 focused command reported 21 test files and 212 tests passed across MCP, IPC, RPC, attach/detach/continue/ps paths.
- C2 focused command reported 16 test files and 157 tests passed across provider, detection, redaction, process error, and event-sink paths.
- C5 focused commands reported 28 test files and 295 tests passed across TUI, palette, picker, readiness, and tree paths.
- C7 reported `npm run test-ci` passed, `npm run test:e2e` passed 6 e2e tests, and coverage passed with 81.64% statements, 72% branches, 83.85% functions, and 83.63% lines.
- C8 reported `npm run typecheck:src`, `npm run typecheck:test`, and `npm run lint` passed during its closure scan.

Closure evidence by lane:

### C1: localhost, MCP, HTTP, IPC, RPC, DNS-rebinding, transport auth

Status: closed/no-new-P0/P1/P2.

Checked:

- `src/engine/mcp/server.ts`, `handlers.ts`, `resolver.ts`, `discovery.ts`, `auth-token.ts`, `types.ts`.
- `src/engine/mcp/tool/operations.ts`, `handler.ts`, `schemas.ts`.
- `src/cli/commands/mcp.ts`.
- `src/engine/ipc/server.ts`, `protocol.ts`, `guards.ts`, `server-entry.ts`, `spawn-server.ts`.
- `src/cli/rpc/run.ts`, `reader.ts`, `dispatch.ts`, `types.ts`, `gates.ts`, `writer.ts`.
- `src/core/paths.ts`, `src/lib/fs.ts`, `src/lib/path-confinement.ts`.
- Docs: `docs/SUBSYSTEMS.md`, `docs/FEATURES.md`, `docs/CLI-REFERENCE.md`, `docs/CONFIGURATION.md`, `docs/GETTING-STARTED.md`, `docs/TROUBLESHOOTING.md`.

Duplicate mapping:

- Local HTTP timeouts/DoS maps to P2-61.
- DNS rebinding/Host/health maps to P2-62; Origin array crash maps to P1-2.
- MCP `401`/`WWW-Authenticate`/PRM maps to P2-82.
- Timing-safe bearer comparison maps to P2-63.
- MCP read/write token scope and wrong-session tools map to P1-125 and P1-1.
- MCP symlink/raw state/evidence text/test gaps map to P1-82, P1-105, P1-73, and P2-19.
- IPC auth/control, malformed input, path hardening, backpressure/replay map to P1-116, P1-22, P1-21, and P1-8.
- RPC abort/disconnect/status/recovery/message/slash risks map to P1-76, P1-151, P1-102, P1-112, P1-115, and P2-69.

### C2: provider/API, credentials, logs, redaction, model metadata, third-party network calls

Status: closed/no-new-P0/P1/P2.

Checked:

- Docs: `docs/API-KEYS.md`, `docs/CONFIGURATION.md`, `docs/CLI-REFERENCE.md`, `docs/SUBSYSTEMS.md`, `README.md`.
- Source: `src/engine/providers/*`, `src/engine/providers/anthropic/*`, `src/engine/providers/model/*`, `src/engine/planners/api.ts`, `src/engine/implementers/api.ts`, `src/engine/agent-sdk-backend.ts`, `src/engine/runners/command-based.ts`, `src/engine/runners/cli.ts`, `src/engine/runners/shell.ts`, `src/engine/detection/service.ts`, `src/engine/detection/cache.ts`, `src/stores/discovery/detection-adapter.ts`, `src/stores/discovery/model-cache.ts`, `src/core/config/accessors/runner-credentials.ts`, `src/core/config/load/load.ts`, `src/core/config/load/validate.ts`, `src/core/schemas/runner-fields.ts`, `src/core/providers/catalog.ts`, `src/core/providers/known-models.ts`, `src/utils/redact.ts`, `src/utils/format-errors.ts`, `src/lib/warn.ts`, `src/lib/process/errors.ts`, `src/engine/events/sinks/jsonl.ts`, `src/engine/events/sinks/stdout-json.ts`, `src/engine/events/sinks/otel.ts`, `src/engine/orchestrator/validation.ts`, and `src/engine/streaming/stream-errors.ts`.

Duplicate mapping:

- Provider failure persistence, raw event sinks, OTel content attributes, provider discovery/cache, custom `apiBase`/env-key risks, SDK retries/logging, and model metadata trust bounds all map to accepted provider/API/logging findings including P0-16, P1-83, P1-109, P1-118, P1-148, P2-68, P2-89, P2-90, and P2-91.

### C3: filesystem, sessions, snapshots, caches, handoff/export artifacts, persistence

Status: closed/no-new-P0/P1/P2.

Checked:

- Source: `src/lib/fs.ts`, `src/lib/path-confinement.ts`, `src/core/paths.ts`, `src/core/paths-io.ts`, `src/core/sessions/*`, `src/core/state/persistence.ts`, `src/core/stats/persistence.ts`, `src/engine/snapshots/*`, `src/engine/handoff/*`, `src/engine/export/*`, `src/engine/codebase/*`, `src/engine/detection/*`, `src/engine/orchestrator/approval/*`, `src/engine/worktree.ts`, `src/cli/commands/handoff.ts`, `src/cli/commands/export.ts`, `src/cli/commands/worktree.ts`, `src/app/command-context.ts`, and slash-command registry paths.
- Tests/contracts: `src/engine/snapshots/store.test.ts`, `src/engine/snapshots/run.test.ts`, `src/engine/handoff/write.test.ts`, `src/engine/handoff/render.test.ts`, `src/engine/export/collect.test.ts`, `src/engine/export/html-renderer.test.ts`.
- Docs: `docs/CLI-REFERENCE.md`, `docs/SLASH-COMMANDS-REFERENCE.md`, `docs/MENTAL-MODEL.md`, `docs/REPOMAP.md`, `README.md`.

Duplicate mapping:

- Filesystem, session, snapshot, cache, handoff/export artifact, symlink/path, and persistence race issues map to accepted findings including P0-11, P0-12, P0-13, P0-15, P1-21, P1-23, P1-24, P1-27, P1-35, P1-45, P1-46, P1-54, P1-82, P1-85, P1-93, P1-109, P1-120, P1-123, P1-127, P1-131, P1-133, P1-145, P2-49, P2-53, P2-59, P2-80, P2-83, P2-84, P2-85, P2-86, and P2-94.

### C4: workflow orchestration, approval gates, recovery, cancellation, active session lifecycle

Status: accepted-new-finding P2-96; no-new-P0/P1.

Checked:

- Docs: `docs/WORKFLOW.md`, `docs/ENGINE.md`, `docs/APPROVAL-AND-RECOVERY.md`, `docs/CLI-REFERENCE.md`, `docs/STORES-AND-UI.md`, `docs/CONFIGURATION.md`, `README.md`, `CLAUDE.md`.
- Source: workflow run/init/phases/session lifecycle, state machine, task loop/step/task-review, recovery actions, approval/cost gates, queue/continuation/signals, headless/RPC/start/resume/continue, IPC server/server-entry/bridge/spawn, TUI workflow runner/prompt/recovery handlers, and app/RPC command contexts.

### P2-96: detached workflows silently abort configured task-review gates

Evidence:

- `src/cli/commands/start.ts:143` starts the `--detach` path by spawning the IPC server without rejecting or adapting `workflow.taskReview`.
- `src/engine/ipc/server-entry.ts:138` calls `runWorkflow()` for detached mode.
- `src/engine/ipc/server-entry.ts:146` through `src/engine/ipc/server-entry.ts:200` provides callbacks for approval, user edit conflict, questions, budget, continuation, and tiered approval, but does not provide `onTaskReviewNeeded`.
- `src/engine/orchestrator/task/task-review.ts:22` enables task review when `workflow.taskReview` is not `none`.
- `src/engine/orchestrator/task/task-review.ts:43` publishes `task_review_needed`.
- `src/engine/orchestrator/task/task-review.ts:44` through `src/engine/orchestrator/task/task-review.ts:47` defaults to `{ action: 'abort' }` when no callback exists.
- `src/cli/headless.ts:66` through `src/cli/headless.ts:68` explicitly rejects task review in headless mode, but detached server-entry bypasses that `runHeadless()` guard.

Impact:

- A customer with `workflow.taskReview: every` or `workflow.taskReview: failed` can run `diptych start --detach ...`.
- The detached workflow reaches a task-review gate, emits the event, immediately treats it as abort, and stops without an attached client ever getting a decision prompt.
- This makes a documented quality gate behave like a silent abort in detached customer workflows.

Fix:

- Either wire `onTaskReviewNeeded` through IPC prompt requests/responses, or reject `workflow.taskReview !== 'none'` for `start --detach` with a clear startup error until detached task review is supported.
- Add detached behavior coverage for both `every` and `failed` task-review modes.

Why not duplicate:

- P1-115 covers missing RPC message-gate behavior coverage; RPC has an `onTaskReviewNeeded` path, detached IPC does not.
- P1-101 and P1-119 cover active-pointer aftermath after approval/cost denial; this is the missing detached decision channel causing a synthetic task-review abort.
- P2-87 covers prompt parsing of unknown task-review input; here no prompt input is possible.
- P1-79 covers false success exit status; this is the distinct gate-wiring fault before terminal status mapping.

### C5: TUI, command palette, input focus, terminal rendering, keyboard behavior

Status: closed/no-new-P0/P1/P2.

Checked:

- Docs: `CLAUDE.md`, `docs/STORES-AND-UI.md`, `docs/SLASH-COMMANDS-REFERENCE.md`, `docs/CLI-REFERENCE.md`, `docs/TESTING.md`, `docs/INVARIANTS.md`.
- Source: `src/app.tsx`, `src/layout.tsx`, `src/app/keys.ts`, `src/app/command-context.ts`, `src/features/palette/*`, `src/core/runtime/commands/*`, `src/components/composer/*`, `src/components/input/*`, `src/components/pickers/*`, `src/features/workflow/screen.tsx`, `src/features/workflow/hooks/*keys*`, `src/features/workflow/components/*prompt*`, `src/features/workflow/components/event-cards/*`, `src/components/markdown.tsx`, `src/components/diff-view.tsx`, `src/lib/terminal/*`, `src/features/settings/*`, `src/features/runners/*`, `src/features/sessions/picker.tsx`, and related `src/stores/ui/*` / `src/stores/workflow/*`.

Duplicate mapping:

- Residual TUI/input/rendering risks map to P1-146, P1-147, P1-63, P2-69, P2-88, P2-95, P1-6, P1-39, P2-37, P2-54, and P2-55.

### C6: installable CLI, npm packaging, release provenance, dependency/license/runtime supply chain

Status: closed/no-new-P0/P1/P2.

Checked:

- Commands: `npm --version`, `node --version`, `npm pack --dry-run --json --ignore-scripts --silent`, `npm ls --omit=dev --depth=0`, `npm audit --omit=dev --json`, `npm view diptych name version dist-tags --json`, `node dist/cli.js --version`, `node dist/cli.js --help`, `npm help publish`.
- Files/surfaces: `package.json`, `package-lock.json`, `README.md`, `.github/`, `dist/cli.js`, representative stale `dist/` import paths, runtime dependency licenses, runtime dependency install scripts, lockfile integrity/resolved URLs, package metadata, package contents.

Duplicate mapping:

- Package overpublish/stale dist/package smoke gaps, npm registry 404, vulnerable prod audit, native install scripts, GPL runtime dependency, missing license/metadata/provenance workflow, unbounded peer/ranged deps, global install peer resolution, no shrinkwrap, and stale/undeclared dist imports all map to accepted release/install findings including P0-1, P0-2, P0-3, P0-6, P0-7, P0-8, P1-11, P1-12, P1-14, P1-32, P1-49, P1-64, P1-70, P1-77, P2-29, P2-30, P2-74, and P2-76.

### C7: tests, CI gates, invariants, behavior-not-implementation coverage

Status: closed/no-new-P0/P1/P2.

Checked:

- Files/configs/docs: `package.json`, `vitest.config.ts`, `testing/e2e/vitest.e2e.config.ts`, `tsconfig.json`, `tsconfig.test.json`, `biome.json`, `docs/TESTING.md`, `docs/INVARIANTS.md`, `docs/STRUCTURE.md`, `docs/NO-BARRELS.md`, `docs/PRINCIPLES.md`, `docs/HOOKS.md`, `docs/STORES.md`, `docs/LAYERS.md`, `src/cli.ts`, `testing/helpers/commander.ts`, `testing/e2e/helpers/e2e-harness.ts`, `testing/e2e/helpers/e2e-config.ts`, and all `testing/e2e/scenarios/*.test.ts`.
- Invariant/test-policy scans: barrels, classes, memoization, store setters, `simple-git`, engine/UI imports, legacy event names, raw `throw new Error`, hidden control bytes, internal `vi.mock`, focused tests, snapshots, `.js` import suffix drift, call-count assertions, spies, `renderHook`, and sleep/timing shortcuts.

Duplicate mapping:

- Material CI, invariant, and coverage gaps map to P0-3, P1-9, P1-10, P1-31, P1-48, P1-77, P2-5, and P2-6.

### C8: clean-code, anti-slop, architecture, TypeScript boundaries, performance hotspots

Status: closed/no-new-P0/P1/P2.

Checked:

- Docs: `CLAUDE.md`, `docs/LAYERS.md`, `docs/INVARIANTS.md`, `docs/TYPES.md`.
- Source scope: 639 production `src/**/*.ts(x)` files.
- Patterns: barrels/index files, disguised export barrels, runtime classes, memo/forwardRef/imperative handles, relative `.js` import suffixes, engine-to-UI imports, `simple-git` boundary, legacy event names, import cycles, type-only boundary imports, `z.infer` placement, `as any`/`@ts-ignore`/non-null assertions, TODO/FIXME/HACK/XXX, sync FS, unbounded `Promise.all`, string accumulation, `structuredClone`, and sort/split render hot paths.
- Spot checks: `src/engine/orchestrator/evidence/review-packet/build.ts`, `src/engine/orchestrator/evidence/review-packet/sections.ts`, `src/components/pickers/two-column-picker/two-column-keyboard.ts`, `src/components/pickers/two-column-picker/use-two-column-state.ts`, `src/engine/agent-sdk-backend.ts`, `src/lib/terminal/mouse.ts`, `src/engine/codebase/graph.ts`, `src/engine/codebase/pagerank.ts`, `src/engine/events/sinks/tree-recorder.ts`.

Duplicate mapping:

- Import cycles map to P2-27.
- Store/engine type-only boundary signals map to P2-41 and P2-42.
- Performance hotspots map to accepted repo-map, streaming, cache, replay, and review-packet findings.

---

## Updated Final Baseline After Convergence Closure

Current status:

- P0-1 through P0-16 remain accepted blocker findings.
- P1-1 through P1-151 remain accepted high-priority findings.
- P2-1 through P2-96 remain accepted medium-priority findings.
- C1, C2, C3, C5, C6, C7, and C8 are closed/no-new-P0/P1/P2 against the current baseline.
- C4 added P2-96 and otherwise reported no-new-P0/P1.

Known finding ranges by loop:

- Initial/early audit findings P0-1 through P0-16, P1-1 through P1-47, and P2-1 through P2-24.
- Fifth-loop findings P1-48 through P1-67.
- Sixth-loop findings P1-68 through P1-81.
- Eighth-loop findings P1-82 through P1-93 and P2-25 through P2-28.
- Ninth-loop findings P1-94 through P1-103 and P2-29 through P2-36.
- Tenth-loop findings P1-104 through P1-115 and P2-37 through P2-42.
- Eleventh-loop findings P1-116 through P1-124 and P2-43 through P2-49.
- Twelfth-loop findings P1-125 through P1-130 and P2-50 through P2-60.
- Thirteenth-loop findings P1-131 through P1-138 and P2-61 through P2-73.
- Fourteenth-loop findings P1-139 through P1-144 and P2-74 through P2-83.
- Fifteenth-loop findings P1-145 through P1-151 and P2-84 through P2-95.
- Convergence closure finding P2-96.

Any future agent must explicitly exclude P0-1 through P0-16, P1-1 through P1-151, and P2-1 through P2-96. Since the convergence closure matrix has now closed C1, C2, C3, C5, C6, C7, and C8 with no new findings, future work should not reopen those lanes for broad discovery unless code changes invalidate the evidence above. The next useful step is fix planning/execution against the accepted baseline, starting with P0 blockers and customer-handoff security risks.

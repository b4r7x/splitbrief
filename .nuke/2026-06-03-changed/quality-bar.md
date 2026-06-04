# Quality Bar — 2026 stack audit checks

Versions (from package.json): TS ^6.0, React ^19.0, Ink ^6.8, Vitest ^4.1.2, @vitest/coverage-v8 ^4.1.2, Biome ^2.0, Zod ^4.3.6, commander ^14, openai ^6, simple-git ^3, yaml ^2, shiki ^4, @anthropic-ai/claude-agent-sdk ^0.3.0, @types/node ^22, tsx ^4.21, Node >=22.

## TypeScript 6
- `strict` is on by default in TS6; audit for code relying on loose nullability now surfacing errors.
- `target` defaults to current-year ES (ES2025); `target: "es5"` deprecated, `--outFile` removed, `module: amd/umd/system/none` removed. Check tsconfig pins target explicitly.
- `rootDir` now defaults to the tsconfig dir (not common source root); verify `dist/` layout unchanged after build.
- `types` defaults to `[]` (no auto-enumeration of `@types`); confirm needed ambient types are listed or imported.
- Use `"ignoreDeprecations": "6.0"` only as temporary bridge; TS7 removes it. Flag as tech-debt, not a fix.

## Zod 4
- Format validators are top-level: `z.email()/z.uuid()/z.url()`, not `z.string().email()`. Flag any chained-method format usage.
- Error customization unified under `error` param; `message`, `invalid_type_error`, `required_error` deprecated. Audit error maps.
- Schema-level `error` now takes precedence over `parse()`-time contextual error (precedence flipped vs v3) — check error-message expectations.
- `ZodError.flatten()` deprecated; prefer `z.treeifyError()`. `.catch()/.default()` on optional props now always return caught/default value (v3 differed).

## Vitest 4
- `workspace` option removed; must use `projects`. Audit vitest config.
- Vite 5 support dropped (needs Vite 6/7). Verify peer.
- `vi.useFakeTimers()` does NOT fake `nextTick`/`queueMicrotask`/`performance` by default — pass `toFake: [...]` if relied on. Audit timer/debounce tests (ESC debounce, escape-seq timers).
- `vi.restoreAllMocks`/`restoreMocks` no longer reset state — only restores manual `vi.spyOn`; automocks unaffected. `mockReset` now restores spy to original impl (not noop). Re-audit mock-reset assumptions.
- `vi.mock` factory must return object with each export explicitly defined (not default). `coverage.ignoreEmptyLines` defaults true (v8) — coverage thresholds may shift.

## Ink 6 / React 19
- React 19: pass `ref` as a normal prop; `forwardRef` deprecated. CLAUDE.md already bans `forwardRef`/`useImperativeHandle` — verify none present.
- `use()` can read context/promises conditionally (post early-return); only valid in render. Check for misuse outside render.
- Always call Ink's `setRawMode` (from `useStdin`), never `process.stdin.setRawMode`. Guard with `isRawModeSupported` before calling — it throws on non-TTY/CI stdin.
- `measureElement()` returns `{0,0}` during render; only call in effect/input/timer callbacks with proper deps.
- Crash without cleanup leaves TTY modes (raw/focus/bracketed-paste) enabled — audit exit paths restore raw mode + disable `\x1b[?2004h` paste mode on exit/SIGINT.
- `useInput` collapses multi-char paste into one callback call — don't treat each call as single keypress.

## Node 22 / child_process / TTY (changeset themes)
- Pass `signal: AbortSignal` to `spawn` for cancellation; `killSignal` default SIGTERM. Audit AbortController propagation through async loops (one controller, abort once, check `signal.aborted` in loops).
- Sandbox/spawned procs: don't spread full `process.env` — pass an explicit allowlist (PATH + needed vars) so API keys/secrets don't leak to subprocesses.
- Bridged `PassThrough` stdin must satisfy TTY members Ink reads (`isTTY`, `setRawMode`, `ref/unref`) — already sanctioned in `filtered-stdin.ts`; verify the bridge forwards/cleans listeners and doesn't double-handle Ctrl+C.
- ESC handling: a lone `\x1b` vs the start of a CSI sequence (`ESC[...`) needs a short debounce timer to disambiguate; tests for this must use fake timers explicitly faking the timer source (see Vitest note).
- Use `\x1b[?2004h/l` bracketed-paste toggles only paired with cleanup; ANSI sequences are non-portable — guard on terminal support.

## Biome 2
- Type-aware rules exist (`noFloatingPromises`, cross-module detection) — opt-in; audit whether enabled and whether floating promises in async loops slip through.
- GritQL plugins/custom rules and configurable import sorting are 2.x features; check `biome.json` schema matches installed 2.x (v2.4 is the 2026 minor).

## claude-agent-sdk 0.3.0
- `query()` resume via `options.resume` (session ID from `system`/`init` message `.sessionId`); `resumeSessionAt` (message UUID), `forkSession` to branch. Verify resume reads session ID from init event, not guessed.
- Pass `options.abortController` for cancellation (defaults to fresh one) — wire app-level AbortController in, don't rely on default.
- `options.env` defaults to `process.env`; set explicit `env` + `cwd` for isolation. `settingSources` defaults `[]` (no CLAUDE.md unless `'project'` included). `permissionMode`/`canUseTool` for gating.
- v2 session API (`unstable_v2_createSession/resumeSession`, `await using`) is preview/unstable — avoid in production paths. (partially unverified — exact 0.3.0 surface)

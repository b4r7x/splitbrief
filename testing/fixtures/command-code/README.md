# Command Code CLI fixtures

**REAL captures, recorded 2026-09-01 against `cmd` 1.39.2** on macOS (darwin 24.5.0).
They replace the hand-authored payloads that previously stood in for them. Each `.txt`
fixture keeps two provenance lines the recorded process never printed — the invocation
and a `# version:` note — followed by verbatim stdout.

| File | Invocation | Notes |
|---|---|---|
| `version.txt` | `cmd --version` | Bare semver on one line. |
| `list-models.txt` | `cmd --list-models` | 61 rows under provider headings. |
| `status.txt` | `cmd status --json` | Exit 0 when authenticated. |
| `json-result.txt` | the implementer adapter's own argv, prompt `Reply with exactly: ok` | The one paid call this capture was authorized to make, on the cheap default model `deepseek/deepseek-v4-flash`. |
| `conformance-record.json` | `cli-conformance` raw → production, role `implementer` | Raw PASS, production OMIT — see below. |

## Divergences from the hand-authored guesses

- **`--list-models` format was wrong in every particular.** The guess was
  `provider/model - Display Name` under tier headings (Cheap/Standard/Frontier). The real
  listing aligns a selection id against a capability blurb with a run of spaces, groups
  rows under *provider* headings (Open Source, Anthropic, OpenAI, Google, Sakana, Meta,
  xAI), and gives first-party models no `provider/` prefix at all (`claude-sonnet-5`,
  `gpt-5.6-sol`). It also ends with `cmd --model …` usage examples and a `Docs:` line.
  The old parser required both a slash and a ` - ` separator, so against the real binary
  it matched nothing and returned `null` — Command Code had no native catalog. The
  rewritten `parseCommandCodeNativeModelCatalog` reads the real shape, and because the
  second column is a blurb rather than a display name, rows now carry no `displayName`.
- **The result frame's failure field is `error`, a plain string.** A failed run emits
  `{"type":"result","subtype":"error",…,"error":"Error: Not authenticated…"}` with no
  `stopReason` and an empty `finalText`, so the adapter's message chain had to read
  `error` first or report the generic fallback instead of the real cause.
- **The success frame matched the guess exactly** — `type`/`subtype`/`sessionId`/
  `stopReason`/`usage`/`finalText`/`durationMs`, with the guessed `usage` key names
  (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) all correct.
- **Event stream names differ.** The run opens with `run_start`, not `session_started`.
  The parser only consumes `tool_running`, whose real payload (`toolCallId`, `toolName`,
  `description`) matches what it reads — confirmed against the shipped `dist`, since the
  recorded run needed no tools.
- **`cmd status --json` returns different fields**: `{authenticated, version, user, model,
  context_window}`, not the guessed `{authenticated, account, credits, model}`.
- **`--effort <level>` exists.** The catalog declared `supportsEffort: false` /
  `effortChannel: 'none'`; the real `--help` documents a per-call effort flag, so the
  declaration is now `effort-flag` and both adapters emit `--effort`.
- **The CLI auto-updates in the background**, which changed the version mid-transaction
  (1.38.2 → 1.39.2) and raced the harness's sandbox teardown into `ENOTEMPTY`. Both
  adapters and the raw contract now pass `--no-auto-update`.

## Credential findings

The credential lives at `~/.commandcode/auth.json` — **unhyphenated**, unlike the
`command-code` tool id. The guessed `~/.command-code/auth.json` does not exist, so the
state bridge would have bridged nothing and every sandboxed run would have failed
unauthenticated.

Its contents are `{apiKey, userId, userName, keyName, authenticatedAt}` — a named,
long-lived API key minted once by `cmd login`, with no refresh token and nothing that
rotates on use. The provisional `rotating-oauth` classification is therefore wrong; it is
a `static-secret` and takes the sealed read-only snapshot.

## API-key environment finding

Still none. `cmd --help` names no credential environment variable, and the shipped bundle
reads only `CMD_LOCAL_ONLY` (BYOK routing), `CMD_ZDR`, `COMMANDCODE_SKIP_UPDATES` and
telemetry/debug switches — no API key, no token. The `session` channel keeps `env: []`
and `src/engine/runners/sandbox-state-paths.ts` keeps no allowlist entry. This is now verified
against the binary rather than inferred from documentation.

## The production conformance leg still OMITs

`conformance-record.json` records raw PASS and production OMIT
(`implementer produced no staged-project change`). The cause is the harness, not the
adapter: `sandboxEnvironment` builds the child's environment with `createSandboxEnv`
without a `selectedCli`, so the child gets a fresh sandbox `HOME` and the session
channel's declared `stateBridge: 'host-cli-state'` never runs. Any `session`-auth CLI
reaches its binary unauthenticated and cannot complete the credentialed leg.

Bridging host credentials into the conformance sandbox is a deliberate security boundary,
so it was left alone. In its place the adapter's exact argv was replayed against the
authenticated binary (`json-result.txt`), which exercises the same parse and terminal
path the production leg would have.

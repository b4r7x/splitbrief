# Authentication method matrix

Whether SPLITBRIEF can *enforce* an authentication method for a single invocation, per admitted CLI, measured against the builds installed on one host.

A **method** is how the tool proves who is paying: a subscription session the host holds, or a metered API credential. A **route** is which provider or model the tool talks to. `--oss`, `--local-provider`, `--model`, `--variant`, `COPILOT_PROVIDER_*` and `cmd --local-only` are routes, not methods, and are never presented as an authentication choice.

Verdicts:

- **enforceable** — the installed adapter forces the selected method for the invocation, and the invocation fails rather than falling back when the selected credential is absent.
- **host-configured** — the tool's own configuration, stored login or documented precedence decides; SPLITBRIEF stages a credential but cannot prove which one the tool takes.
- **unsupported** — no method choice exists to make.

**Result: every admitted CLI is `host-configured`. No adapter is proven enforceable on this host.** That is a completed outcome, not an open item; the reasoning per tool is below.

## Current invocation contract

The runtime enforcement matrix `CLI_AUTH_ENFORCEMENT_EVIDENCE` is empty. No real session/API method switch is proven. `enforceCliAuthInvocation` requires positive evidence for the exact tool, platform and installed version before dispatching an explicit `session` or `api-key` choice. Without it the invocation is refused; omit the selection to use the host CLI configuration. The picker offers no method switch for these rows. A stored login, staged environment or model listing does not establish which billing method a call used.

The measurements below record the staging behavior researched before that enforcement gate was added. They explain why no method was admitted; they are not instructions to configure an explicit method today.

## Measurement environment

macOS (`darwin`), Node 22.22.2, repository baseline `e6ffb1bc`. Every capture is a `--version` or `--help`/help-topic invocation with no prompt and no subcommand that reads or writes credentials. No generation was run, no secret file was read, no login state was touched. Where a control is documented only in a tool's help text and was not exercised, this document says so rather than assuming the text.

Versions are the build on this host; the parenthesised value is `compatibility.testedVersion` in `src/core/runners/cli-tool-catalog.ts`. A control observed on a newer build is not evidence for `minimumAdmittedVersion`.

## Admitted CLIs

| Tool | Executable (installed / catalog tested) | Declared channels | Current method choice offered | Verdict |
|---|---|---|---|---|
| `claude-code` | `~/.local/bin/claude` — 2.1.273 (2.0.0) | `session`, `api-key` | no | host-configured |
| `codex` | `…/node/v22.22.2/bin/codex` — 0.154.0 (0.40.0) | `session`, `api-key` | no | host-configured |
| `cursor` | `~/.local/bin/cursor-agent` — 2026.09.08-6caf4ff (2026.08.25-3e8eec8) | `session`, `api-key` | no | host-configured |
| `opencode` | `~/.opencode/bin/opencode` — 2.0.4 (0.5.0) | `provider-dependent` | no | host-configured |
| `kilo-code` | `/opt/homebrew/bin/kilo` — 7.0.49 (0.1.0) | `provider-dependent` | no | host-configured |
| `copilot` | `~/.local/bin/copilot` — 1.0.83 (1.0.77) | `session` | no | host-configured |
| `command-code` | `…/node/v22.22.2/bin/cmd` — 1.54.1 (1.39.2) | `session` | no | host-configured |
| `antigravity` | `~/.local/bin/agy` — 1.2.4 (1.2.2) | `session` | no | host-configured |

Every tool declares `roles: ['planner', 'implementer']`; the reviewer seat reuses the planner runner (`resolveReviewerRunner`). The channel set is the tool's `auth.channels` in `cli-tool-catalog.ts`; "method choice offered" requires invocation-enforcement evidence, not merely multiple declared channels. The custom-only exclusions (`kiro`, `gemini`, `cline`, `qwen`, `auggie`, `junie`) are not admitted and have no row.

## Per-channel facts

| Tool · channel | Invocation control SPLITBRIEF emits | Credential sources the child keeps | Sources excluded |
|---|---|---|---|
| `claude-code` · `session` | none | macOS: real `HOME`/`USER`, so the login keychain resolves. Linux/Windows: sealed read-only copy of `.claude/.credentials.json` | `ANTHROPIC_API_KEY` (not in the channel's `env`) |
| `claude-code` · `api-key` | none | `ANTHROPIC_API_KEY` only | private `HOME`; nothing bridged |
| `codex` · `session` | none | live passthrough of `~/.codex/auth.json` (`rotating-oauth`) | `OPENAI_API_KEY` |
| `codex` · `api-key` | none | `OPENAI_API_KEY` only | private `HOME`; nothing bridged |
| `cursor` · `session` | none | macOS: real `HOME`/`USER` (keychain). Linux/Windows: live passthrough of the declared Cursor state paths | `CURSOR_API_KEY` |
| `cursor` · `api-key` | none | `CURSOR_API_KEY` only | private `HOME`; nothing bridged |
| `opencode` · `provider-dependent` | none | live passthrough of `~/.config/opencode/auth.json`, **plus every `*_API_KEY` in the parent environment** | nothing |
| `kilo-code` · `provider-dependent` | none | the tool's live state directory, **plus every `*_API_KEY`** | nothing |
| `copilot` · `session` | none | `GH_TOKEN` / `GITHUB_TOKEN` **and** a sealed copy of Copilot's credential files, simultaneously | nothing |
| `command-code` · `session` | none | sealed copy of the tool's credential files | no credential env var exists |
| `antigravity` · `session` | none | macOS: real `HOME`/`USER` (`host-account`), with no copied files. Linux/Windows: credential bridge unsupported | no credential env var is admitted by this adapter |

No adapter emits an authentication flag. `src/engine/runners/cli-tools/cursor.ts:34` names `--api-key`, but only inside `CURSOR_PROTECTED_FLAGS` — the denylist that stops a user's `invocationArgs` from setting it. A repository-wide search for `--bare`, `--api-key`, `apiKeyHelper` and `preferred_auth_method` in `src/` returns that one denylist entry and nothing else. Method selection therefore reaches every tool the same way: by what the staged environment holds, never by argv.

The `*_API_KEY` passthrough on provider-dependent channels is deliberate and is documented on `cliAuthChannelEnvKeys` (`src/engine/runners/sandbox-env.ts`): OpenCode and Kilo hold no credential of their own, so stripping the host's provider keys would strand the very credentials their model listing was built from. The cost is that these two channels retain *all* competing credentials by construction.

## Behavior under competing, missing and shared credentials

**Competing credentials.** Only Copilot documents a precedence, and it is the host's, not SPLITBRIEF's: `copilot help environment` states that `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` (in that order) are "an authentication token that takes precedence over previously stored credentials". SPLITBRIEF's Copilot `session` channel declares both the env vars and the file bridge, so both sources are present at once and the tool's rule decides. No other admitted tool's help states a precedence between an environment credential and a stored login, so for every other tool the outcome is whatever the installed build does.

**Missing selected credential.** In the earlier staging probe, readiness could report missing credentials while environment construction still allowed a launch. Current dispatch no longer treats that staging result as authorization. An explicit `session` or `api-key` selection without exact invocation-enforcement evidence is refused before the child starts, regardless of alternate host credentials. The matrix remains empty; use host configuration by omitting the choice.

**Shared login state.** SPLITBRIEF does not invoke login, logout or account-switch commands. File staging depends on the tool: Codex, OpenCode and Kilo use live state paths; Cursor does so where its channel uses files. Claude Code, Copilot and Command Code use sealed copies where file staging applies. The macOS session channels for Claude Code, Cursor and Antigravity instead keep the real `HOME` and `USER` so the OS keychain is reachable. Those children can update their own host state; the sealed-file guarantee does not apply to them. Antigravity has no admitted file bridge on other platforms. These rules come from `cliAuthChannelHostStateAccess` and `CLI_CREDENTIAL_MODELS`, not an authentication-method guarantee.

**Staging parity.** The historical probe and runner share environment-construction rules; current dispatch additionally requires method-enforcement evidence. The readiness probe (`probeEnvironment`, `src/engine/runners/cli-tools/cli-probe-process.ts`) and the runner (`createRunnerSandboxEnv`, `src/engine/runners/sandbox-env.ts`) both derive their preserved environment from `cliAuthChannelEnvKeys(channel)` and their host-state posture from `cliAuthChannelHostStateAccess(channel)`. The only difference is the sandbox root: the probe passes no `role` and a neutral `projectDir`, the runner passes both. That changes which directory the child gets, not which credential — so a channel the probe calls authenticated is a channel the runner stages identically.

**Catalog-probe exception: OpenCode enumeration.** One probe stands outside that parity, and only for listing models. OpenCode 2 answers `model.list` (`opencode api GET /api/model`) from its own background server, and that server materializes a directory's providers when it first sees it — a neutral `mkdtemp` root is therefore answered with an empty snapshot, and a private `--standalone` server enumerates nothing at all. The sandbox also cannot supply an `env`-type provider connection: `opencode auth list` reports Kimi and Ollama Cloud as environment credentials, and a staged child that inherits no environment reaches 86 of the 118 models the account can serve, short by exactly those providers. So the OpenCode catalog probe declares `hostState: 'host-account'` (`CliCatalogProbe`, `src/engine/runners/cli-tools/contract.ts`), honoured only by `catalogProbeEnvironment` in `src/engine/detection/catalog-probe.ts`. The neutral root exists for staging parity, not as containment for a read-only listing: `GET /api/model` is a read, and measured against a stamped filesystem the child appends to one file, `~/.local/share/opencode/log/opencode.log`, inside a directory the live state bridge already exposes. OpenCode's **dispatch** staging is unchanged and still derives from `cliAuthChannelHostStateAccess`, so this exception widens no credential — it only lets a listing see the environment the user's own shell has.

## Controls that exist in the installed builds but are not used

These are the only per-invocation method controls found in any installed tool's help. None is emitted today, and none is proven; each is recorded so a later card can evaluate it instead of rediscovering it.

- **`claude --bare`** (2.1.273) is the one documented native enforcement in the whole set: "Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and keychain are never read)." It would make the `claude-code` `api-key` channel enforceable — but it also disables hooks, LSP, plugin sync, auto-memory and `CLAUDE.md` auto-discovery, so adopting it is a behavior change to the planner seat, not a flag flip. It is absent from `CLAUDE_BASE_ARGS`, and its presence in `minimumAdmittedVersion` 2.0.0 is unknown.
- **`cursor-agent --api-key <key>`** supplies a key for the invocation and is documented as equivalent to `CURSOR_API_KEY`. The help says nothing about what happens when it is absent or rejected, so it is an input, not proof of precedence.
- **`codex -c <key=value>` with `--strict-config`** can override any `~/.codex/config.toml` key for one invocation and error on keys this build does not recognise. Whether a method-selecting key exists under that mechanism was not established: settling it means running Codex against a staged config, which is more than a help capture.
- **`copilot`'s `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` precedence** proves the environment beats the stored login when the environment holds a token. It says nothing about the reverse case — an empty environment falls back to the stored login by design — so it cannot enforce a *selected* method.
- **`cmd --local-only`** and **`codex --oss` / `--local-provider`** are route switches. `cli-tool-catalog.ts` already records that `cmd --help` names no API-key environment variable, which is why Command Code declares a `session` channel only.
- **`agy --help`** (1.2.4, historical capture) exposed no authentication flag, variable or login subcommand. Current [upstream authentication docs](https://antigravity.google/docs/cli/install/#using-a-gemini-api-key), checked 2026-09-17, describe a Gemini API-key mode using a settings change plus `GEMINI_API_KEY`. SPLITBRIEF still admits only the host-configured session channel; no per-invocation method switch or fallback behavior has been proven for this adapter.

## Why no row is enforceable

For the three tools that offer a choice, the `api-key` channel gets a private `HOME` and no bridged state, so on this host the subscription session is not reachable through the tool's default lookup — the macOS login keychain resolves through `HOME`, and `~/.codex` and `~/.claude` do not exist inside the sandbox. That is staging, not enforcement. It proves what the environment contains, not what the binary consults: a build free to open an absolute path, a keychain by explicit name, or a machine-wide configuration would still find a session, and nothing in these tools' help documents that they will not. Per this card's evidence rule, a staging observation alone does not establish native fallback precedence, so the verdict stays `host-configured`.

For the five single-channel tools there is nothing to enforce, because no method choice is offered. REQ-016 is satisfied for them by silence: the UI must state that the host CLI's own configuration determines authentication, and must not present the provider or model list as an authentication choice.

## Limits of this document

Single host, macOS only. Linux and Windows file-staging postures are read from declarations, not measured here. Antigravity is the exception: its credential bridge is admitted only on macOS, and other platforms remain unsupported with unknown authentication. Every row reflects the installed build named in the table; the catalog's `minimumAdmittedVersion` is older than every one of them, and no claim here extends downward to it. Nothing was proven by generation, by reading a credential file, or by changing a login.

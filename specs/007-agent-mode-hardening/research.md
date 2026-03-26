# Research: Agent-Mode Implementer & Workflow Hardening

**Date**: 2026-03-26 | **Branch**: `007-agent-mode-hardening`

## 1. Agent-Mode Subprocess Patterns

### 1.1 File Change Detection After Agent Exits

**Decision**: Use `git.status()` / `git diff --name-only` after the agent process exits.

**Rationale**: Already proven in the codebase (`src/utils/git.ts` uses `simple-git` for `getCurrentDiff()`, `hasExternalChanges()`, `discardTaskChanges()`). Git is a prerequisite. Zero overhead, no watchers, no race conditions.

**Alternatives considered**:
- Filesystem watchers (chokidar/fs.watch): Unreliable across platforms, requires setup/teardown, can miss rapid changes
- mtime snapshots: Slow for large repos, 1-second resolution on HFS+, doesn't catch deletes reliably

**Pattern**: If the agent runs in a clean working tree (post-previous-commit), just check `git.status()` after exit — any changes were made by the agent.

### 1.2 Shell Function Resolution

**Decision**: Direct `spawn()` first (fast path). On ENOENT, retry with `$SHELL -lc "command ..."` (resolves functions/aliases from user's login profile).

**Rationale**:
- `spawn('cmd', args)` works for PATH executables (claude, aider, codex). Fast, no overhead.
- `$SHELL -lc` sources the user's full profile. On macOS (default zsh), this sources `.zshrc`/`.zprofile` where functions like `claude-zai` are defined.
- `-lc` (login + command) is correct. `-ic` (interactive) produces TTY noise (PS1, job control messages). Never use `-ic`.
- `process.env.SHELL` detects the user's actual shell (don't hardcode bash).

**Alternatives considered**:
- `bash -ic`: Produces prompt noise on stdout/stderr. Not suitable for programmatic use.
- Hardcoded `bash -lc`: Wrong on macOS where default shell is zsh. `.bashrc` functions invisible from bash login shell.

### 1.3 Task Description Delivery

**Decision**: Stdin piping (most universal). Matches existing `shell.ts` pattern.

**Rationale**: Any CLI tool can read stdin. No tool-specific flag knowledge needed. Handles arbitrary prompt sizes. The existing shell implementer already does this (`proc.stdin.write(prompt); proc.stdin.end()`).

**Alternatives considered**:
- CLI arg (`-p "task..."`): Tool-specific flags vary. ARG_MAX limits (~256KB on macOS).
- Temp file: Extra I/O, cleanup needed. Useful for prompts >100KB but overkill as default.

**For agent mode specifically**: The agent command may accept the task differently (via `-p`, `--message`, positional arg). Config should allow specifying args with a `{prompt}` placeholder, e.g., `args: ["-p", "{prompt}"]`. If no placeholder, default to stdin.

### 1.4 Timeout and Process Cleanup

**Decision**: `spawn()` with `detached: true` + `process.kill(-pid, 'SIGTERM')` for process group killing. SIGTERM → wait 5s → SIGKILL escalation.

**Rationale**: POSIX standard for killing a process tree. No external dependency. Instant. Agent tools spawn subprocesses (language servers, sub-agents) that must be cleaned up.

**Current gap**: `src/utils/process.ts` only sends SIGTERM to the direct child (`proc.kill('SIGTERM')`). Grandchild processes survive. Agent mode must use `-pid` (negative PID = process group).

**Alternatives considered**:
- `tree-kill` npm: Does `ps`-based process tree walk. Platform-dependent, slower. Unnecessary when we control spawn options.

## 2. CLI Version Detection

### 2.1 Version Commands

| Tool | Command | Output | Regex |
|------|---------|--------|-------|
| Claude Code | `claude --version` | `2.1.84 (Claude Code)` | `/^(\d+\.\d+\.\d+)/` |
| Codex | `codex --version` | `codex-cli 0.111.0` | `/(\d+\.\d+\.\d+)/` |
| Aider | `aider --version` | `aider vX.Y.Z` | `/(\d+\.\d+\.\d+)/` |
| OpenCode | `opencode --version` | `1.2.27` | `/^(\d+\.\d+\.\d+)/` |

All tools already have `isAvailable()` methods that call `--version` but only check exit code, not the version string. Enhancement: capture and return the version.

### 2.2 Version-to-Flags Mapping

**Decision**: The `--verbose` flag for Claude Code is NOT version-gated — it is always required when using `-p` + `--output-format stream-json`. The current code already includes `--verbose`. No flag mapping needed today.

**Future-proofing**: Build a simple `VersionFlags[]` lookup table structure so flag changes can be added when real version-dependent behavior appears.

### 2.3 Semver Parsing

**Decision**: Two pure functions (`parseVersion`, `versionGte`), no new dependency.

**Rationale**: Only need parse + compare. No range matching, no pre-release handling. 5 lines of code vs. 70KB `semver` package. Project has 7 production deps and wants to stay minimal.

## 3. Question Parser Fixes

### 3.1 Greedy Bracket Matching

**Decision**: Replace regex with balanced-brace scanner (Option D).

**Current regex**: `/<!-- Q:(\{.*?\}) -->/g` — non-greedy `.*?` stops at first `} -->`. Breaks if JSON contains `}` followed by ` -->` in a string value.

**Fix**: Scan for `<!-- Q:{`, count braces (respecting string literals and escapes), find matching `}`, verify ` -->` follows. ~30 lines, handles all edge cases.

**Practical severity**: Low — planner-generated question payloads are simple flat objects. But the fix is cheap insurance.

### 3.2 Buffer Bloat

**Decision**: Trim buffer after extracting questions. Keep only trailing incomplete data.

**Current bug**: `buffer += chunk` grows unbounded. `extractQuestionsFromStream(buffer)` re-scans the entire buffer every chunk — O(n^2) total.

**Fix**: After extracting, find the last complete `-->` marker and trim everything before it. ~10 lines.

### 3.3 Question ID Deduplication

**Decision**: Add `Set<string>` for seen IDs in the accumulator. Filter duplicates before returning.

**Fix**: ~5 lines. Trivial defensive measure.

### 3.4 Split Across Chunks

**Status**: Already works correctly. The accumulator buffers all chunks and re-parses. Test at `tests/question-parser.test.ts:102-109` explicitly covers this. Preserve this behavior when applying buffer-trimming fix.

## 4. Conversational TUI Hardening

### 4.1 Session Continuity Detection

**Finding**: Only `claude-code` and `agent-sdk` backends support session continuity. The `claude-code` backend tracks `sessionId` from the stream. Other backends (codex, aider, opencode, shell) are stateless.

**Decision**: Check `planner.name` or add a `supportsSessionContinuity()` method to `PlannerBackend`. When comment-on-approval is selected with a non-session planner, show message: "Comment requires session continuity. Available actions: approve, edit, quit."

### 4.2 Comment-on-Approval Flow

**Finding**: The regeneration flow (`orchestrator.ts:402-412`) calls `planner.regenerate()` which uses `spawnClaudePlanner()` with the existing `sessionId`. If the session has expired (Claude Code session timeout), the regeneration silently starts a new context.

**Decision**: Accept this behavior — a fresh context with the current spec + user comment is still useful. No recovery mechanism needed for expired sessions.

### 4.3 Interrupt Handling

**Finding**: The orchestrator has a `shutdown()` handler (line 262) that calls `killAllProcesses()`. But TUI input components don't have cleanup hooks for SIGINT during interactive prompts.

**Decision**: Ink's built-in SIGINT handling (exits the process) is sufficient. The `shutdown()` handler in orchestrator.ts already cleans up. No additional work needed beyond ensuring state is saved before each interactive prompt.

## Summary of Decisions

| Topic | Decision | New Code |
|-------|----------|----------|
| File change detection | `git.status()` after agent exit | ~10 lines in `implementers/agent.ts` |
| Shell function resolution | Direct spawn → `$SHELL -lc` fallback | ~15 lines in `implementers/agent.ts` |
| Task delivery | Stdin (default), configurable args with `{prompt}` placeholder | ~10 lines |
| Process cleanup | `detached: true` + `kill(-pid)` | ~20 lines, update `utils/process.ts` |
| Version detection | Capture version from `--version` output | ~15 lines in each planner |
| Semver parsing | Two pure functions, no dep | ~10 lines in new `utils/version.ts` |
| Version-to-flags | Not needed today, table structure for future | ~5 lines |
| Question parser brackets | Balanced-brace scanner | ~30 lines replacing regex |
| Question parser buffer | Trim after extraction | ~10 lines |
| Question dedup | `Set<string>` in accumulator | ~5 lines |
| Session continuity | Check planner capability, graceful fallback | ~10 lines |
| Constitution amendment | Principle VI → v1.2.0, carve-out for delegated file writes | Text change only |

# Decisions

## D1: Move workflow-events.ts to events layer (not duplicate)

The events layer (`src/engine/events/`) is foundational — orchestrator depends on it, not the reverse. Moving the file (not duplicating) keeps one source of truth and prevents future drift.

## D2: Extract routing fields helper (not inline simplification)

The 8-field spread appears 3 times and will grow when new routing metadata is added. A helper function is the minimal DRY fix — no abstraction, just a function.

## D3: Standardize on fzf library (not custom scorer)

The `fzf` library is already a dependency used by slash-commands. The custom subsequence scorer in `utils/fuzzy-match.ts` produces different rankings for the same query. Users expect consistent fuzzy behavior across palette and commands. One algorithm, one ranking.

## D4: Faux provider at interface level (not HTTP level)

For orchestrator behavioral tests, we faux at the Planner/Implementer interface — not at the HTTP/fetch level. This is faster, more deterministic, and tests the orchestrator logic (which is what matters). HTTP-level faux is separate future work for testing `api.ts` parsing.

## D5: Keep error matchers even though unused in production

The `is*` error matchers (`isInvalidData`, `isEscapesProject`, etc.) are exported but only used in tests today. Per project convention ("error at boundaries — callers decide"), these will be needed when error handling matures. Keep them.

## D6: Don't remove IPC despite YAGNI flag

The IPC subsystem (12 files: server, spawn, heartbeat, lockfile, protocol, replay, etc.) supports `ps`/`attach`/`detach` — diptych's competitive advantage over pi-mono. Not YAGNI; it's core infrastructure.

## D7: Score normalization for fzf (Math.min(1, score/100))

The old custom scorer returned [0, 1]. fzf returns unbounded positive integers. We normalize with `Math.min(1, score/100)` to preserve the same contract. If consumers have specific thresholds, the implementer must verify they still trigger correctly.

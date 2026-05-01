# 01 - Planner Heartbeat

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Show token count and phase hint during long planner waits (>5s) instead of a bare spinner with only elapsed seconds. Users should see liveness signal: tokens accumulating and what the planner is currently doing.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, rendered output, or public state.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- kebab-case file names.

## Required Reading

- `CLAUDE.md`
- `docs/STORES.md`
- `src/components/spinner.tsx`
- `src/features/workflow/components/event-cards/planner-status-card.tsx`
- `src/features/workflow/components/agent-status-row.tsx`
- `src/engine/events/types.ts`
- `src/engine/orchestrator/planning/shared.ts`
- `src/stores/workflow/tokens.ts`
- `src/stores/workflow/events.ts`

## Write Ownership

Primary files:

```text
src/engine/orchestrator/planning/heartbeat.ts
src/engine/orchestrator/planning/heartbeat.test.ts
src/features/workflow/components/event-cards/planner-status-card.tsx (modify)
src/engine/events/types.ts (modify — add event type)
```

Do not edit plan editor files. Do not edit streaming files.

## Design

### New Event Type

Add to `EngineEvent` union in `src/engine/events/types.ts`:

```typescript
| { type: 'planner_heartbeat'; ts: number; phase: Phase; elapsedMs: number; accumulatedTokens: number; phaseHint?: string }
```

### Heartbeat Publisher

Create `src/engine/orchestrator/planning/heartbeat.ts`:

```typescript
import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';

const HEARTBEAT_THRESHOLD_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 2000;

interface HeartbeatState {
  accumulatedTokens: number;
  phaseHint: string | undefined;
}

interface HeartbeatHandle {
  updateTokens(tokens: number): void;
  updatePhaseHint(hint: string): void;
  stop(): void;
}

export function startPlannerHeartbeat(
  bus: EventBus,
  phase: Phase,
  startTime: number,
): HeartbeatHandle {
  const state: HeartbeatState = { accumulatedTokens: 0, phaseHint: undefined };
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  function publish(): void {
    bus.publish({
      type: 'planner_heartbeat',
      ts: Date.now(),
      phase,
      elapsedMs: Date.now() - startTime,
      accumulatedTokens: state.accumulatedTokens,
      ...(state.phaseHint !== undefined ? { phaseHint: state.phaseHint } : {}),
    });
  }

  const threshold = setTimeout(() => {
    started = true;
    publish();
    timer = setInterval(publish, HEARTBEAT_INTERVAL_MS);
  }, HEARTBEAT_THRESHOLD_MS);

  return {
    updateTokens(tokens: number): void {
      state.accumulatedTokens = tokens;
    },
    updatePhaseHint(hint: string): void {
      state.phaseHint = hint;
    },
    stop(): void {
      clearTimeout(threshold);
      if (timer !== null) clearInterval(timer);
    },
  };
}
```

### Integration Point

In `src/engine/orchestrator/planning/shared.ts`, inside `runPlannerCallInContinuationLoop`, start the heartbeat before the continuation loop body and stop it after:

```typescript
import { startPlannerHeartbeat } from './heartbeat.js';

// Inside runPlannerCallInContinuationLoop, before the loop:
const heartbeat = startPlannerHeartbeat(wctx.bus, state.phase, Date.now());

// In the onOutput callback, update tokens from the latest cost event:
// (tokens are already tracked by the bus — subscribe to cost_update)
// After the loop resolves:
heartbeat.stop();
```

Wire the token accumulation: when a `cost_update` event is seen during planning, call `heartbeat.updateTokens(totalInputTokens + totalOutputTokens)`.

Wire the phase hint: set `heartbeat.updatePhaseHint(...)` based on the planning mode entry points:
- `'analyzing repo map'` when `buildRepoMap` is running (before the planner call)
- `'generating spec'` / `'generating plan'` / `'generating briefs'` based on the current planning step

### Enhanced PlannerStatusCard

Modify `src/features/workflow/components/event-cards/planner-status-card.tsx` to show heartbeat data when a `planner_heartbeat` event is the latest event:

```tsx
import { Text, Box } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme } from '../../../../components/theme.js';
import { Spinner } from '../../../../components/spinner.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { formatToolModel } from '../../../../core/model-display.js';
import { phaseRole } from '../../../../core/phases.js';
import { eventsStore } from '../../../../stores/workflow/events.js';
import { createLatestEventByTypeSelector } from '../latest-event-selector.js';

type PlannerStatusEvent = Extract<EngineEvent, { type: 'planner_status' }>;

const selectLatestHeartbeat = createLatestEventByTypeSelector('planner_heartbeat');

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

export function PlannerStatusCard({ event }: { event: PlannerStatusEvent }) {
  const t = useTheme();
  const role = phaseRole(event.phase);
  const color = role === 'implementer' ? t.implementer : t.planner;
  const toolLabel = formatToolModel(event.tool, event.model);
  const latestHeartbeat = eventsStore.use(selectLatestHeartbeat);

  if (event.status === 'running') {
    const suffix = toolLabel ? ` (${toolLabel})` : '';
    const heartbeatSuffix = latestHeartbeat && latestHeartbeat.accumulatedTokens > 0
      ? ` · ${formatTokenCount(latestHeartbeat.accumulatedTokens)}`
      : '';
    const hintSuffix = latestHeartbeat?.phaseHint
      ? ` · ${latestHeartbeat.phaseHint}`
      : '';

    return (
      <Box flexDirection="column">
        <Spinner
          label={`${role}  ${event.phase}${suffix}...`}
          color={color}
          startTime={event.ts}
        />
        {(heartbeatSuffix || hintSuffix) && (
          <Text color={t.textDim}>  {heartbeatSuffix}{hintSuffix}</Text>
        )}
      </Box>
    );
  }

  const dur = event.duration ? ` ${formatDuration(event.duration)}` : '';
  return (
    <Text>
      <Text color={color}>{role}</Text>
      <Text color={t.success}> ✓ {event.phase}</Text>
      <Text color={t.textDim}>{dur}</Text>
      {toolLabel && <Text color={t.textDim}> [{toolLabel}]</Text>}
      {event.summary && <Text color={t.textDim}> {event.summary}</Text>}
    </Text>
  );
}
```

## Required Behavior

1. When a planner call runs longer than 5 seconds, a `planner_heartbeat` event is published every 2 seconds.
2. The heartbeat carries accumulated input+output tokens and an optional phase hint.
3. `PlannerStatusCard` renders the heartbeat info below the spinner when available.
4. When the planner call completes, the heartbeat timer is stopped and no more events are published.
5. If the planner call completes in under 5 seconds, no heartbeat events are published.

### Event Merging

In `src/stores/workflow/events.ts`, extend `mergeEvent` to collapse consecutive `planner_heartbeat` events (same pattern as `validate` running events):

```typescript
if (event.type === 'planner_heartbeat' && last?.type === 'planner_heartbeat') {
  const next = events.slice();
  next[next.length - 1] = event;
  return next;
}
```

This prevents the events array from accumulating many heartbeat entries during long planner calls.

## Non-Goals

- No new top-level progress bar component.
- No streaming output in this brief.
- No plan editor changes.
- No changes to the approval loop.

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- Engine code must not import React/Ink/features/components/hooks.
- `heartbeat.ts` is engine code — pure functions and timers, no React.
- Tests should use fake timers and a mock event bus.
- Tests should verify: heartbeat fires after threshold, carries correct token count, stops on `.stop()`, does not fire before threshold.

## Validation Commands

Run targeted tests:

```bash
npm test -- src/engine/orchestrator/planning/heartbeat.test.ts
```

Then run:

```bash
npm run typecheck
npm run lint
```

## Expected Final Report

Report:

- files changed
- heartbeat event shape
- integration points modified
- PlannerStatusCard rendering changes
- validation commands run and results
- risks or follow-ups

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE, sessionDir } from '../../../src/core/paths.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { runPlanningPhase } from '../../../src/engine/orchestrator/planning/run.js';
import type { OrchestratorCallbacks } from '../../../src/engine/orchestrator/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  TEST_METADATA,
  TEST_SINKS,
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const MISSING_IMPLEMENTATION_STEPS_TASKS_MD = `---
id: T001
title: Create hello module
action: create
file: src/hello.ts
---

### Description

Create a hello world module.

### Tests

- returns the expected greeting

### Type Definitions

\`\`\`ts
export function hello(): string
\`\`\`

### Scope

**In bounds:**
- src/hello.ts

**Out of bounds:**
- unrelated files

### Evidence

- brief-quality.json records a passing gate
`;

const COMPLETE_TASKS_MD = `---
id: T001
title: Create hello module
action: create
file: src/hello.ts
---

### Description

Create a hello world module.

### Tests

- returns the expected greeting

### Type Definitions

\`\`\`ts
export function hello(): string
\`\`\`

### Implementation Steps

1. Implement the module

### Scope

**In bounds:**
- src/hello.ts

**Out of bounds:**
- unrelated files

### Evidence

- brief-quality.json records a passing gate
`;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('brief quality repair loop', () => {
  it('a planner whose briefs fail the linter twice then pass ends in reviewing-briefs with the linter issues fed back', async () => {
    const projectDir = createTempDir('brief-quality-repair-test');
    dirs.push(projectDir);
    const sessionId = 'sess-brief-quality-repair';
    ensureSessionDir(projectDir, sessionId);

    const regenerationPrompts: string[] = [];
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makeTask({ scope: undefined, evidence: [] })],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      review: vi.fn().mockImplementation(async (prompt: string) => {
        regenerationPrompts.push(prompt);
        return regenerationPrompts.length === 1
          ? { text: MISSING_IMPLEMENTATION_STEPS_TASKS_MD, usage: null }
          : { text: COMPLETE_TASKS_MD, usage: null };
      }),
    });

    const approvalPrompts: string[] = [];
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementation((type) => {
        approvalPrompts.push(type);
        return type === 'briefs'
          ? new Promise<never>(() => {})
          : Promise.resolve({ approved: true } as const);
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    void runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { mode: 'standard', approve: 'spec', maxRetries: 2 } }),
        callbacks,
        bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('brief quality repair'), { type: 'START' }),
      feature: 'brief quality repair',
    });

    await vi.waitFor(
      () => {
        expect(approvalPrompts).toContain('briefs');
      },
      { timeout: 10_000 },
    );

    expect(onApprovalNeeded).toHaveBeenCalledWith(
      'briefs',
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
    );
    expect(loadState({ projectDir, sessionId })?.phase).toBe('reviewing-briefs');

    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(planner.review).toHaveBeenCalledTimes(2);
    expect(regenerationPrompts).toHaveLength(2);
    expect(regenerationPrompts[0]).toContain('Task T001 has no scope definition');
    expect(regenerationPrompts[0]).toContain('Task T001 has no Evidence field entries');
    expect(regenerationPrompts[1]).toContain('Task T001 has no implementation steps');

    const gateEvents = events
      .filter(
        (event) => event.type === 'brief_quality_failed' || event.type === 'brief_quality_passed',
      )
      .map((event) => event.type);
    expect(gateEvents).toEqual([
      'brief_quality_failed',
      'brief_quality_failed',
      'brief_quality_passed',
    ]);

    const report = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE), 'utf-8'),
    );
    expect(report.passed).toBe(true);
  }, 20_000);
});

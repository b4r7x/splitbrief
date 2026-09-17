import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  SPEC_FILE,
  sessionDir,
} from '../../../core/paths.js';
import type { EngineEvent } from '../../events/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import type { Planner } from '../../planners/types.js';
import { runAnalyzeCall, runClarifyCall, runConstitutionCall } from './speckit.js';
import type { PlanningStepsOptions } from './types.js';

const SAMPLE_SPEC = '# Spec\n\n- requirement A\n';
const ANALYZE_RESULT =
  '```json\n{"specTaskCoverage":1,"planTaskCoverage":1,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setup(opts?: { constitution?: string; review?: Planner['review'] }): {
  opts: PlanningStepsOptions;
  state: WorkflowState;
  projectDir: string;
  sessionId: string;
  events: EngineEvent[];
  planner: Planner;
} {
  const projectDir = createTempDir('speckit-call');
  dirs.push(projectDir);
  const sessionId = 'sess-speckit';
  ensureSessionDir(projectDir, sessionId);
  writeFileSync(join(sessionDir(projectDir, sessionId), SPEC_FILE), SAMPLE_SPEC, 'utf8');
  if (opts?.constitution !== undefined) {
    mkdirSync(join(projectDir, '.specify', 'memory'), { recursive: true });
    writeFileSync(join(projectDir, '.specify', 'memory', 'constitution.md'), opts.constitution);
  }
  const { bus, events } = makeBusRecorder();
  const planner = makePlanner({
    review: opts?.review ?? vi.fn().mockResolvedValue({ text: ANALYZE_RESULT, usage: null }),
  });
  const state: WorkflowState = {
    ...createInitialState('add login'),
    phase: 'constitution-check',
    mode: 'speckit',
  };
  saveState({ projectDir, sessionId }, state);
  return {
    opts: {
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { mode: 'speckit', approve: 'none' } }),
        callbacks: makeCallbacks().callbacks,
        bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state,
      feature: 'add login',
    },
    state,
    projectDir,
    sessionId,
    events,
    planner,
  };
}

describe('runClarifyCall', () => {
  it('writes the clarifications pointer without spending a planner call', () => {
    const fixture = setup();
    runClarifyCall(fixture.opts, fixture.state);

    const text = readFileSync(
      join(sessionDir(fixture.projectDir, fixture.sessionId), CLARIFICATIONS_FILE),
      'utf8',
    );
    expect(text).toContain('# Clarifications');
    expect(text).toContain('session.jsonl');
    expect(fixture.planner.review).not.toHaveBeenCalled();
  });
});

describe('runConstitutionCall', () => {
  it('passes without a planner call when the project declares no constitution', async () => {
    const fixture = setup();
    const result = await runConstitutionCall(fixture.opts, fixture.state, 'add login');

    expect(result.halted).toBe(false);
    expect(fixture.planner.review).not.toHaveBeenCalled();
    const verdict = JSON.parse(
      readFileSync(
        join(sessionDir(fixture.projectDir, fixture.sessionId), CONSTITUTION_CHECK_FILE),
        'utf8',
      ),
    );
    expect(verdict).toEqual({ passed: true, violations: [] });
  });

  it('checks the spec against the constitution and records the verdict', async () => {
    const review = vi.fn().mockResolvedValue({
      text: '```json\n{"passed":true,"violations":[{"principle":"P1","reason":"style","severity":"soft"}]}\n```',
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    const fixture = setup({ constitution: '# Rules', review });

    const result = await runConstitutionCall(fixture.opts, fixture.state, 'add login');

    expect(result.halted).toBe(false);
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toContain('Constitution Check');
    expect(result.state.tokenUsage.plannerInput).toBe(4);
    const verdict = JSON.parse(
      readFileSync(
        join(sessionDir(fixture.projectDir, fixture.sessionId), CONSTITUTION_CHECK_FILE),
        'utf8',
      ),
    );
    expect(verdict.violations).toHaveLength(1);
  });

  it('halts for a decision on a hard violation and keeps the run open', async () => {
    const review = vi.fn().mockResolvedValue({
      text: '```json\n{"passed":false,"violations":[{"principle":"P1","reason":"bad","severity":"hard"}]}\n```',
      usage: null,
    });
    const fixture = setup({ constitution: '# Rules', review });

    const result = await runConstitutionCall(fixture.opts, fixture.state, 'add login');

    expect(result.halted).toBe(true);
    expect(result.state.phase).toBe('constitution-check');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'constitution-check-failed',
      seat: 'plan',
      availableActions: ['revise-spec', 'end-run'],
      recommendedAction: 'revise-spec',
    });
    expect(result.state.closed).toBeUndefined();
    expect(existsSync(join(sessionDir(fixture.projectDir, fixture.sessionId), ANALYZE_FILE))).toBe(
      false,
    );
  });

  it('treats malformed output as a soft meta violation rather than a failure', async () => {
    const review = vi.fn().mockResolvedValue({ text: 'not json at all', usage: null });
    const fixture = setup({ constitution: '# Rules', review });

    const result = await runConstitutionCall(fixture.opts, fixture.state, 'add login');

    expect(result.halted).toBe(false);
    const verdict = JSON.parse(
      readFileSync(
        join(sessionDir(fixture.projectDir, fixture.sessionId), CONSTITUTION_CHECK_FILE),
        'utf8',
      ),
    );
    expect(verdict.violations[0]).toMatchObject({ principle: 'meta', severity: 'soft' });
  });
});

describe('runAnalyzeCall', () => {
  it('records the coverage it measured and books the review spend', async () => {
    const review = vi.fn().mockResolvedValue({
      text: ANALYZE_RESULT,
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const fixture = setup({ review });

    const state = await runAnalyzeCall(fixture.opts, fixture.state);

    expect(review).toHaveBeenCalledTimes(1);
    expect(state.tokenUsage.plannerInput).toBe(7);
    expect(state.tokenUsage.plannerOutput).toBe(3);
    const analysis = JSON.parse(
      readFileSync(join(sessionDir(fixture.projectDir, fixture.sessionId), ANALYZE_FILE), 'utf8'),
    );
    expect(analysis.specTaskCoverage).toBe(1);
  });

  it('warns when coverage is below the configured threshold', async () => {
    const review = vi.fn().mockResolvedValue({
      text: '```json\n{"specTaskCoverage":0.4,"planTaskCoverage":0.5,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```',
      usage: null,
    });
    const fixture = setup({ review });

    await runAnalyzeCall(fixture.opts, fixture.state);

    expect(
      fixture.events.some(
        (event) =>
          event.type === 'warning' && 'message' in event && /coverage below/.test(event.message),
      ),
    ).toBe(true);
  });

  it('records the zero-coverage fallback when the output is malformed', async () => {
    const review = vi.fn().mockResolvedValue({ text: 'nothing structured here', usage: null });
    const fixture = setup({ review });

    await runAnalyzeCall(fixture.opts, fixture.state);

    const analysis = JSON.parse(
      readFileSync(join(sessionDir(fixture.projectDir, fixture.sessionId), ANALYZE_FILE), 'utf8'),
    );
    expect(analysis).toMatchObject({
      specTaskCoverage: 0,
      planTaskCoverage: 0,
      warnings: ['analyze output malformed'],
    });
  });
});

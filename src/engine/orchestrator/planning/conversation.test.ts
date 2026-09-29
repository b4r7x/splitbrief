import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { PLANNER_DOCUMENT_FIXTURES } from '#testing/helpers/factories/phase-call.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { ensureSessionDir, writeSpecFile } from '../../../core/paths-io.js';
import { sessionDir, RESEARCH_FILE, SPEC_FILE } from '../../../core/paths.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { deriveRunStatus, NO_ARTIFACTS } from '../../../core/sessions/run-status.js';
import { createPhaseRunner } from '../../planners/run-phase.js';
import { createContinuationHolder } from '../continuation.js';
import type { PlannerCallbacksContext } from '../types.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { buildPlannerCallFailedRecoveryIssue } from '../recovery/builders/planner.js';
import { runPlanningSteps } from './steps.js';
import { emitRecoveryAndFailIfPending } from '../../../cli/headless.js';

const reply =
  '"refactor me a coda" isn’t enough to plan against — no target module, no known problem. What are we refactoring: a specific file/feature, or something broken you’ve noticed?';
const documents = [
  PLANNER_DOCUMENT_FIXTURES.research,
  PLANNER_DOCUMENT_FIXTURES.spec,
  PLANNER_DOCUMENT_FIXTURES.plan,
  REAL_TASKS_MD,
];
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setup() {
  const projectDir = createTempDir('planner-conversation');
  dirs.push(projectDir);
  const sessionId = 'conversation';
  ensureSessionDir(projectDir, sessionId);
  const state: WorkflowState = {
    ...transition(createInitialState('hey whatsup refactor me a coda'), { type: 'START' }),
    mode: 'standard',
    approve: 'none',
  };
  saveState({ projectDir, sessionId }, state);
  const { bus, events } = makeBusRecorder();
  const wctx: PlannerCallbacksContext = {
    projectDir,
    sessionId,
    config: makeConfig(),
    callbacks: makeCallbacks().callbacks,
    bus,
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
  };
  return { projectDir, sessionId, state, wctx, events };
}

function scripted(outputs: string[]) {
  const prompts: string[] = [];
  const files: Array<string | undefined> = [];
  const runPhase = createPhaseRunner({
    invokePlan: async ({ prompt, artifactFile, callContext, callbacks }) => {
      prompts.push(prompt);
      files.push(artifactFile);
      const text = outputs.shift();
      if (text === undefined) throw new Error('Unexpected planner invocation');
      callbacks.onOutput(text);
      return makeRunnerCallResult({ callId: callContext.callId, text, status: 'completed' });
    },
  });
  return { planner: makePlanner({ runPhase }), prompts, files };
}

describe('planner conversations through the real phase boundary', () => {
  it.each([false, true])(
    'persists and displays the answer before continuing (native session: %s)',
    async (nativeSession) => {
      const fixture = setup();
      const scriptedCall = scripted([reply, ...documents]);
      const { prompts, files } = scriptedCall;
      const planner = makePlanner({
        ...scriptedCall.planner,
        capabilities: {
          ...scriptedCall.planner.capabilities,
          supportsSessionResume: nativeSession,
        },
      });
      if (nativeSession) {
        fixture.state.plannerSessionId = 'native-conversation';
      }
      fixture.wctx.callbacks.onPlannerReply = vi.fn(async () => {
        expect(loadState(fixture)?.pendingPlannerConversation).toMatchObject({
          call: 'research',
          text: reply,
          answered: false,
        });
        expect(
          existsSync(join(sessionDir(fixture.projectDir, fixture.sessionId), RESEARCH_FILE)),
        ).toBe(false);
        expect(
          fixture.events.some(
            (event) => event.type === 'error' || event.type === 'artifact_written',
          ),
        ).toBe(false);
        return 'Refactor src/auth.ts to remove duplicate credential checks.';
      });
      const result = await runPlanningSteps({
        wctx: fixture.wctx,
        state: fixture.state,
        planner,
        feature: fixture.state.feature,
        approveLevel: 'none',
      });
      expect(result.disposition).toBe('tasks-ready');
      expect(files).toEqual(['research.md', 'research.md', 'spec.md', 'plan.md', 'tasks.md']);
      expect(prompts[1]).toContain('remove duplicate credential checks');
      expect(prompts[1]).toContain('[User reply]');
      expect(prompts[1]).not.toContain('You were interrupted');
      expect(prompts[1]).not.toContain('previous attempt of this step was interrupted');
      expect(prompts[1]).toContain('Do not invoke or search for native user-question tools');
      const replies = fixture.events.filter((event) => event.type === 'user_message');
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        text: 'Refactor src/auth.ts to remove duplicate credential checks.',
      });
      const answerIndex = fixture.events.findIndex((event) => event.type === 'user_message');
      const documentIndex = fixture.events.findIndex(
        (event) => event.type === 'planner_text' && event.text.includes('# Research'),
      );
      expect(answerIndex).toBeLessThan(documentIndex);
      expect(loadState(fixture)?.pendingPlannerConversation).toBeUndefined();
      expect(fixture.wctx.callbacks.onPlannerReply).toHaveBeenCalledTimes(1);
    },
  );

  it('parks headless with input-required, then resumes without asking the model to repeat its question', async () => {
    const fixture = setup();
    const first = scripted([reply]);
    const parked = await runPlanningSteps({
      wctx: fixture.wctx,
      state: fixture.state,
      planner: first.planner,
      feature: fixture.state.feature,
    });
    expect(parked).toMatchObject({ disposition: 'terminal', outcome: 'input-required' });
    const saved = loadState(fixture);
    if (saved === null) throw new Error('Missing persisted conversation');
    expect(
      deriveRunStatus({ state: saved, liveness: 'not-alive', artifacts: NO_ARTIFACTS }),
    ).toMatchObject({
      stop: { kind: 'input-required' },
      resumeAt: { kind: 'planner', call: 'research' },
    });
    const writeRecord = vi.fn();
    expect(() =>
      emitRecoveryAndFailIfPending({ state: saved, sessionId: fixture.sessionId, writeRecord }),
    ).toThrow('needs your reply');
    expect(writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'input_required', call: 'research' }),
      process.stdout,
    );
    const resumed = scripted([...documents]);
    fixture.wctx.continuation = createContinuationHolder({
      step: { kind: 'planner', call: 'research' },
      steer: 'Refactor src/auth.ts.',
    });
    fixture.wctx.callbacks.onPlannerReply = vi.fn();
    const result = await runPlanningSteps({
      wctx: fixture.wctx,
      state: saved,
      planner: resumed.planner,
      feature: saved.feature,
      approveLevel: 'none',
    });
    expect(result.disposition).toBe('tasks-ready');
    expect(resumed.files).toEqual(['research.md', 'spec.md', 'plan.md', 'tasks.md']);
    expect(resumed.prompts[0]).toContain('Refactor src/auth.ts.');
    expect(fixture.wctx.callbacks.onPlannerReply).not.toHaveBeenCalled();
  });

  it.each(['continuation', 'queued correction'] as const)(
    'continues the recorded legacy failure with %s despite the old specifying resume target',
    async (answerSource) => {
      const fixture = setup();
      writeSpecFile(fixture, RESEARCH_FILE, reply);
      const issue = buildPlannerCallFailedRecoveryIssue({
        diagnosis: {
          failure: 'call-failed',
          message: 'Invalid specifying artifact spec.md: missing Markdown heading',
        },
        phase: 'specifying',
        createdAt: '2026-09-17T20:21:13Z',
      });
      const state: WorkflowState = {
        ...fixture.state,
        phase: 'specifying',
        pendingRecovery: issue,
      };
      saveState(fixture, state);
      const retried = applyRecoveryAction({
        ...fixture,
        state,
        action: 'retry-same-worker',
        ...(answerSource === 'queued correction' ? { comment: 'Refactor src/auth.ts.' } : {}),
        bus: fixture.wctx.bus,
      });
      expect(retried.ok).toBe(true);
      if (answerSource === 'continuation') {
        fixture.wctx.continuation = createContinuationHolder({
          step: { kind: 'planner', call: 'spec' },
          steer: 'Refactor src/auth.ts.',
        });
      }
      fixture.wctx.callbacks.onPlannerReply = vi.fn();
      const { planner, prompts, files } = scripted([...documents]);
      const result = await runPlanningSteps({
        wctx: fixture.wctx,
        state: retried.state,
        planner,
        feature: state.feature,
        startAt: 'spec',
        approveLevel: 'none',
      });
      expect(result.disposition).toBe('tasks-ready');
      expect(files).toEqual(['research.md', 'spec.md', 'plan.md', 'tasks.md']);
      expect(prompts[0]).toContain('Refactor src/auth.ts.');
      expect(fixture.wctx.callbacks.onPlannerReply).not.toHaveBeenCalled();
      expect(loadState(fixture)?.pendingRecovery).toBeUndefined();
    },
  );

  it('retains earlier questions and answers across multiple stateless turns', async () => {
    const fixture = setup();
    const { planner, prompts } = scripted([
      reply,
      'What behavior must remain unchanged?',
      ...documents,
    ]);
    fixture.wctx.callbacks.onPlannerReply = vi
      .fn()
      .mockResolvedValueOnce('src/auth.ts')
      .mockResolvedValueOnce('Keep the CLI exit codes.');
    const result = await runPlanningSteps({
      wctx: fixture.wctx,
      state: fixture.state,
      planner,
      feature: fixture.state.feature,
      approveLevel: 'none',
    });
    expect(result.disposition).toBe('tasks-ready');
    expect(prompts[2]).toContain('src/auth.ts');
    expect(prompts[2]).toContain('What behavior must remain unchanged?');
    expect(prompts[2]).toContain('Keep the CLI exit codes.');
  });

  it('retries a failed PLAN call with the operator correction and preserves completed research', async () => {
    const fixture = setup();
    writeSpecFile(fixture, RESEARCH_FILE, PLANNER_DOCUMENT_FIXTURES.research);
    const issue = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'call-failed', message: 'Planner disconnected' },
      phase: 'specifying',
      createdAt: '2026-09-17T20:21:13Z',
    });
    const state: WorkflowState = { ...fixture.state, phase: 'specifying', pendingRecovery: issue };
    saveState(fixture, state);
    const retried = applyRecoveryAction({
      ...fixture,
      state,
      action: 'retry-same-worker',
      comment: 'Keep the public API unchanged.',
      bus: fixture.wctx.bus,
    });
    expect(retried.ok).toBe(true);
    const { planner, prompts, files } = scripted(documents.slice(1));
    const result = await runPlanningSteps({
      wctx: fixture.wctx,
      state: retried.state,
      planner,
      feature: state.feature,
      startAt: 'spec',
      approveLevel: 'none',
    });
    expect(result.disposition).toBe('tasks-ready');
    expect(files).toEqual(['spec.md', 'plan.md', 'tasks.md']);
    expect(prompts[0]).toContain('Keep the public API unchanged.');
  });

  it('does not ask an answered question again after cancellation during the resumed call', async () => {
    const fixture = setup();
    const controller = new AbortController();
    fixture.wctx.signal = controller.signal;
    fixture.wctx.callbacks.onPlannerReply = vi.fn().mockResolvedValue('src/auth.ts');
    const first = scripted([reply]);
    const firstRun = first.planner.runPhase;
    let calls = 0;
    first.planner.runPhase = async (input) => {
      if (++calls === 2) {
        expect(loadState(fixture)?.pendingPlannerConversation?.answered).toBe(true);
        controller.abort();
        throw new DOMException('Stopped', 'AbortError');
      }
      return firstRun(input);
    };
    await runPlanningSteps({
      wctx: fixture.wctx,
      state: fixture.state,
      planner: first.planner,
      feature: fixture.state.feature,
    });
    const saved = loadState(fixture);
    if (saved === null) throw new Error('Missing state');
    fixture.wctx.signal = undefined;
    fixture.wctx.callbacks.onPlannerReply = vi.fn();
    const resumed = scripted([...documents]);
    const result = await runPlanningSteps({
      wctx: fixture.wctx,
      state: saved,
      planner: resumed.planner,
      feature: saved.feature,
      approveLevel: 'none',
    });
    expect(result.disposition).toBe('tasks-ready');
    expect(fixture.wctx.callbacks.onPlannerReply).not.toHaveBeenCalled();
    expect(resumed.prompts[0]).toContain('src/auth.ts');
    expect(fixture.events.filter((event) => event.type === 'user_message')).toHaveLength(1);
  });

  it('deduplicates optional markers and keeps question-only spec output out of artifacts', async () => {
    const fixture = setup();
    const marker =
      '<!-- Q:{"id":"scope","type":"choice","text":"Which module?","options":["auth","CLI"],"default":"auth"} -->';
    const { planner } = scripted([PLANNER_DOCUMENT_FIXTURES.research, `${marker}\n${marker}`]);
    const result = await runPlanningSteps({
      wctx: fixture.wctx,
      state: fixture.state,
      planner,
      feature: fixture.state.feature,
    });
    expect(result).toMatchObject({ outcome: 'input-required' });
    expect(loadState(fixture)?.pendingPlannerConversation?.questions).toHaveLength(1);
    expect(existsSync(join(sessionDir(fixture.projectDir, fixture.sessionId), SPEC_FILE))).toBe(
      false,
    );
  });

  it('stopping a reply wait preserves the pending question and ends the wait', async () => {
    const fixture = setup();
    const controller = new AbortController();
    fixture.wctx.signal = controller.signal;
    fixture.wctx.callbacks.onPlannerReply = vi.fn(async () => {
      controller.abort();
      return new Promise<string>(() => {});
    });
    const { planner } = scripted([reply]);
    const result = await runPlanningSteps({
      wctx: fixture.wctx,
      state: fixture.state,
      planner,
      feature: fixture.state.feature,
    });
    expect(result).toMatchObject({ outcome: 'interrupted' });
    expect(loadState(fixture)?.pendingPlannerConversation).toMatchObject({
      text: reply,
      answered: false,
    });
  });
});

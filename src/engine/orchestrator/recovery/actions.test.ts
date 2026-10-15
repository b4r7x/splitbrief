import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { configPath } from '../../../core/config/load/document.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir, writeSpecFile } from '../../../core/paths-io.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { applyRecoveryAction, commitSeatSwitch, planSwitchSeatRecoveryAction } from './actions.js';
import { resumeSeatWait } from '../escalation/seat-wait.js';
import { buildConsultBoundRecoveryIssue } from './builders/consult.js';
import { buildReviewFailedRecoveryIssue, buildSeatDownIssue } from './builders/task.js';
import { EngineEventSchema } from '../../events/schema.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import {
  attachedMessage,
  expectCompactMessage,
  expectResumedMessage,
} from '#testing/helpers/user-message.js';
import { transitionAndSave } from '../state-ops.js';
import { formatDrainedMessages } from '../queue/prompt.js';

const createdAt = '2026-04-28T12:00:00.000Z';

describe('typed review overrides', () => {
  it('records effective typed blockers and unresolved criteria instead of edited markdown', async () => {
    const ref = setupSession('typed-override');
    const issue = buildReviewFailedRecoveryIssue({
      blocking: 1,
      phase: 'complete',
      createdAt,
      acceptAsIs: true,
    });
    const state: WorkflowState = {
      ...makeImplState([]),
      phase: 'complete',
      reviewStatus: 'failed',
      pendingRecovery: issue,
      review: {
        cycle: 0,
        at: createdAt,
        outcome: 'fail',
        verification: [],
        verdict: {
          tasks: [],
          criteria: [{ id: 'C1', status: 'unverified', evidence: 'Render pending' }],
          findings: [
            {
              id: 'F1',
              kind: 'unverified',
              severity: 'minor',
              taskId: null,
              file: null,
              line: null,
              text: 'Need proof',
              acceptance: null,
              checkIds: ['K1'],
              criterionId: null,
            },
          ],
        },
      },
    };
    saveState(ref, state);
    writeSpecFile(
      ref,
      'review.md',
      '### Verdict\n\nfail\n\n### Findings\n\n**Critical**\n\n- STALE markdown blocker',
    );
    const result = await applyRecoveryAction({
      ...ref,
      state,
      action: 'accept-as-is',
      bus: makeBusRecorder().bus,
    });
    expect(result.ok).toBe(true);
    expect(result.state.acceptedAsIs?.findings).toEqual([
      'Need proof',
      'Criterion C1: unverified — Render pending',
    ]);
  });
});

let dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(name: string): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('applyRecoveryAction: halt policy', () => {
  it("blocks an action its cause's halt does not offer even when advertised in state", async () => {
    const { projectDir, sessionId } = setupSession('policy-block');
    const task = makeTask({ id: 'T200', status: 'in_progress' });
    const issue = makeRecoveryIssue({
      reason: 'runner-usage-limit',
      phase: 'implementing',
      taskId: task.id,
      taskTitle: task.title,
      files: [task.suggestedFiles[0]],
      affectedTaskIds: [task.id],
      availableActions: ['retry-same-worker', 'accept-as-is', 'end-run'],
      recommendedAction: 'retry-same-worker',
    });
    const state = { ...makeImplState([task]), pendingRecovery: issue };
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'accept-as-is',
      bus,
      config: makeConfig(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('action-not-available');
    expect(result.message).toContain('not allowed');
  });
});

describe('applyRecoveryAction: continue', () => {
  it('blocks continue on a live cause that is not a spent bound, even if the issue advertised it', async () => {
    const { projectDir, sessionId } = setupSession('continue-unsafe');
    const persistedIssue = makeRecoveryIssue();
    const issue: RecoveryIssue = {
      ...persistedIssue,
      availableActions: ['continue', 'retry-same-worker', 'skip-current-task', 'end-run'],
    };
    const base = makeImplState([makeTask({ id: 'T001' })]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: persistedIssue });
    const state = { ...base, pendingRecovery: issue };
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'continue',
      bus,
    });

    expect(result).toMatchObject({ ok: false, status: 'blocked', code: 'unsafe-continue' });
    expect(result.state.pendingRecovery).toEqual(issue);
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(persistedIssue);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_action_failed']),
    );
  });

  it('continues past a halt on a retired cause, which names nothing the run still checks', async () => {
    const { projectDir, sessionId } = setupSession('continue-retired');
    const issue = makeRecoveryIssue({
      reason: 'constitution-check-failed',
      availableActions: ['continue', 'end-run'],
      recommendedAction: 'continue',
    });
    const base = makeImplState([makeTask({ id: 'T001' })]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: issue },
      action: 'continue',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
    expect(events.map((event) => event.type)).toContain('recovery_resolved');
  });
});

describe('applyRecoveryAction: the run-level answers', () => {
  it.each(['planner-revise', 'seat-retry', 'review-correction'] as const)(
    'delivers an attached file through %s and records compact text once',
    async (route) => {
      const ref = setupSession(`attached-${route}`);
      const message = attachedMessage(ref.projectDir);
      const issue: RecoveryIssue =
        route === 'review-correction'
          ? buildReviewFailedRecoveryIssue({ blocking: 1, phase: 'complete', createdAt })
          : route === 'planner-revise'
            ? reviseIssue('brief-review-no-progress')
            : {
                id: 'seat-failed',
                reason: 'planner-call-failed',
                phase: 'planning',
                seat: 'plan',
                status: 'awaiting-user',
                files: [],
                affectedTaskIds: [],
                message: 'Planning failed',
                details: [],
                availableActions: ['retry-same-worker', 'end-run'],
                recommendedAction: 'retry-same-worker',
                createdAt,
              };
      const state: WorkflowState = {
        ...makeImplState([]),
        phase: route === 'review-correction' ? 'complete' : 'planning',
        pendingRecovery: issue,
        ...(route === 'review-correction' ? { reviewStatus: 'failed' as const } : {}),
      };
      saveState(ref, state);
      const { bus, events } = makeBusRecorder();
      bus.subscribe(createJsonlSink(ref));
      const result = await applyRecoveryAction({
        ...ref,
        state,
        action: route === 'seat-retry' ? 'retry-same-worker' : 'revise',
        comment: message,
        bus,
      });
      expect(result).toMatchObject({
        ok: true,
        status: 'continued',
        correctionRecorded: true,
      });
      const seatText =
        route === 'review-correction'
          ? result.state.pendingTriage?.inputs[0]?.text
          : formatDrainedMessages(result.state.messageQueue);
      expect(seatText).toContain('PELICAN-42');
      if (route !== 'review-correction')
        expect(result.state.messageQueue[0]).toMatchObject(message);
      await expectCompactMessage(ref, events, message);
      if (route !== 'review-correction') {
        transitionAndSave(ref, result.state, {
          type: 'DRAIN_QUEUE',
          ids: result.state.messageQueue.map((queued) => queued.id),
        });
      }
      await expectResumedMessage(ref, message);
    },
  );

  function plannerHaltState(projectDir: string, sessionId: string, issue: RecoveryIssue) {
    const base = makeImplState([makeTask({ id: 'T001' })]);
    const state = { ...base, pendingRecovery: issue };
    saveState({ projectDir, sessionId }, state);
    const saved = loadState({ projectDir, sessionId });
    if (saved === null) throw new Error('expected the halt to persist');
    return saved;
  }

  function reviseIssue(reason: RecoveryIssue['reason']): RecoveryIssue {
    return {
      id: `rec_${reason}`,
      reason,
      phase: 'reviewing-briefs',
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: [],
      message: 'the planner needs a correction',
      details: [],
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
      createdAt,
    };
  }

  it('revise queues the comment and clears the halt', async () => {
    const { projectDir, sessionId } = setupSession('recovery-revise');
    const state = plannerHaltState(projectDir, sessionId, reviseIssue('brief-review-no-progress'));
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'revise',
      bus,
      comment: plainUserMessage('split the first brief'),
    });

    expect(result).toMatchObject({ ok: true, status: 'continued', correctionRecorded: true });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.messageQueue.map((message) => message.text)).toEqual([
      'split the first brief',
    ]);
    expect(loadState({ projectDir, sessionId })?.messageQueue).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
  });

  it('revise with no comment still resolves the halt and queues nothing', async () => {
    const { projectDir, sessionId } = setupSession('recovery-revise-empty');
    const state = plannerHaltState(projectDir, sessionId, reviseIssue('brief-review-no-progress'));
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'revise',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'continued', correctionRecorded: false });
    expect(result.state.messageQueue).toHaveLength(0);
    expect(result.state.pendingRecovery).toBeUndefined();
  });

  // No spec step is left to rewind to: an old run's constitution halt sends its note to the one
  // planning session as a queued correction.
  it('revise on an old constitution halt queues the note and clears the halt', async () => {
    const { projectDir, sessionId } = setupSession('recovery-revise-constitution');
    const issue = {
      ...reviseIssue('constitution-check-failed'),
      phase: 'constitution-check' as const,
    };
    const state = plannerHaltState(projectDir, sessionId, issue);
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'revise',
      bus,
      comment: plainUserMessage('drop the class'),
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.rewindPending).toBeUndefined();
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.messageQueue.map((message) => message.text)).toEqual(['drop the class']);
    expect(loadState({ projectDir, sessionId })?.messageQueue).toHaveLength(1);
  });

  it('switch-seat on a plan-seat halt resolves it without resetting a brief', async () => {
    const { projectDir, sessionId } = setupSession('recovery-plan-seat-swap');
    const issue: RecoveryIssue = {
      id: 'rec_planner_call_failed',
      reason: 'planner-call-failed',
      phase: 'planning',
      status: 'awaiting-user',
      seat: 'plan',
      files: [],
      affectedTaskIds: [],
      message: 'Planning failed.',
      details: [],
      switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
      availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
      recommendedAction: 'switch-seat',
      createdAt,
    };
    const state = plannerHaltState(projectDir, sessionId, issue);
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'switch-seat',
      bus,
      config: makeConfig(),
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.tasks[0]?.status).toBe(state.tasks[0]?.status);
  });

  it('end-run closes the run and refuses every later transition', async () => {
    const { projectDir, sessionId } = setupSession('recovery-end-run');
    const state = plannerHaltState(projectDir, sessionId, reviseIssue('brief-review-no-progress'));
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'end-run',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'closed' });
    expect(result.state.closed?.as).toBe('ended');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.closed?.as).toBe('ended');
    expect(events.filter((event) => event.type === 'recovery_resolved')).toEqual([
      expect.objectContaining({ action: 'end-run', outcome: 'aborted' }),
    ]);
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
  });

  it('continue on a task-less planner-calls-spent issue grants five calls without resetting a task', async () => {
    const { projectDir, sessionId } = setupSession('recovery-planner-calls');
    const base = makeImplState([makeTask({ id: 'T001', status: 'in_progress' })]);
    const spent = { ...base, plannerCalls: { used: 10, allowance: 10 } };
    const issue = buildConsultBoundRecoveryIssue({
      reason: 'planner-calls-spent',
      lastDiagnosis: 'The review needs triage',
      plannerCalls: 10,
      plannerCallAllowance: 10,
      phase: 'implementing',
      createdAt,
    });
    saveState({ projectDir, sessionId }, { ...spent, pendingRecovery: issue });
    const state = loadState({ projectDir, sessionId });
    if (state === null) throw new Error('expected the halt to persist');
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'continue',
      bus,
      comment: plainUserMessage('grant it'),
    });

    expect(issue.taskId).toBeUndefined();
    expect(issue.affectedTaskIds).toEqual([]);
    expect(issue.details).toContain('Continuing grants five more planner calls.');
    expect(result).toMatchObject({ ok: true, status: 'continued', correctionRecorded: false });
    if (!result.ok) return;
    expect(result.state.plannerCalls).toEqual({ used: 10, allowance: 15 });
    expect(result.state.messageQueue).toEqual([]);
    expect(events.filter((event) => event.type === 'user_message')).toEqual([]);
    expect(result.state.tasks).toEqual(state.tasks);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(events.map((event) => event.type)).not.toContain('task_reset');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
  });
});

describe('applyRecoveryAction: revise on a failed review', () => {
  function failedReviewHalt(projectDir: string, sessionId: string): WorkflowState {
    const issue = buildReviewFailedRecoveryIssue({
      id: 'rec_review_correction',
      blocking: 1,
      phase: 'complete',
      createdAt,
    });
    const state = {
      ...makeImplState([
        makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' }),
      ]),
      phase: 'complete' as const,
      reviewStatus: 'failed' as const,
      fixCycles: { used: 2, allowance: 2, notes: [] },
      pendingRecovery: issue,
    };
    saveState({ projectDir, sessionId }, state);
    const loaded = loadState({ projectDir, sessionId });
    if (loaded === null) throw new Error('expected the halt to persist');
    return loaded;
  }

  it('queues the correction as a triage input and moves the run back to final-review', async () => {
    const { projectDir, sessionId } = setupSession('recovery-review-correction');
    const state = failedReviewHalt(projectDir, sessionId);
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'revise',
      bus,
      comment: plainUserMessage('log the error, then rethrow it'),
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    if (!result.ok) return;
    expect(result.state.phase).toBe('final-review');
    expect(result.state.reviewStatus).toBeUndefined();
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.pendingTriage).toEqual({
      inputs: [
        {
          id: 'U1',
          kind: 'defect',
          source: 'user',
          text: 'log the error, then rethrow it',
          file: null,
        },
      ],
    });
    // The cap grants one more cycle and records the operator's note.
    expect(result.state.fixCycles).toEqual({
      used: 2,
      allowance: 3,
      notes: ['log the error, then rethrow it'],
    });
    // The correction never resets a brief; the fix work is triaged into new tasks.
    expect(result.state.tasks[0]?.status).toBe('done');
    expect(events.map((event) => event.type)).toContain('user_message');
    expect(events.map((event) => event.type)).not.toContain('review_fix_started');
    expect(events.map((event) => event.type)).not.toContain('task_reset');
  });

  it('resolves even when no correction text is given', async () => {
    const { projectDir, sessionId } = setupSession('recovery-review-correction-empty');
    const state = failedReviewHalt(projectDir, sessionId);
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'revise',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'continued', correctionRecorded: false });
    if (!result.ok) return;
    expect(result.state.phase).toBe('final-review');
    expect(result.state.pendingTriage).toEqual({ inputs: [] });
    expect(result.state.pendingRecovery).toBeUndefined();
  });
});

function usageLimitIssue(task: Task): RecoveryIssue {
  return {
    id: `rec_${task.id}_usage_limit`,
    reason: 'runner-usage-limit',
    phase: 'implementing',
    status: 'awaiting-user',
    taskId: task.id,
    taskTitle: task.title,
    files: [task.suggestedFiles[0]],
    affectedTaskIds: [task.id],
    message: 'Codex hit its usage limit.',
    details: [],
    switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }, { tool: 'opencode' }] },
    availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
    recommendedAction: 'switch-seat',
    createdAt,
  };
}

describe('applyRecoveryAction: switch-seat', () => {
  it('records the catalog name for both sides of a fallback switch', async () => {
    const ref = setupSession('catalog-seat-switch');
    const task = makeTask({ status: 'in_progress' });
    const candidate = { tool: 'codex', model: 'gpt-6-luna', effort: 'high' } as const;
    const issue = {
      ...usageLimitIssue(task),
      switchSeat: { seat: 'build' as const, candidates: [candidate] },
    };
    const state = { ...makeImplState([task]), pendingRecovery: issue };
    saveState(ref, state);
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6-luna', effort: 'low' },
    });
    const result = await applyRecoveryAction({
      ...ref,
      state,
      config,
      bus: makeBusRecorder().bus,
      action: 'switch-seat',
      candidate,
      modelCache: makeModelCacheAccessor({
        providerModels: { codex: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
      }),
    });
    expect(result.state.seatSwitches?.[0]).toMatchObject({
      from: 'OpenAI Codex CLI · GPT-6-Luna · low',
      to: 'OpenAI Codex CLI · GPT-6-Luna · high',
    });
  });

  it.each([
    'version: 3\nplanner:\n  kind: cli\n  tool: invalid-tool\n',
    'version: 3\nplanner: [broken\n',
  ])('blocks a manual switch when config.yaml does not load: %s', async (rawYaml) => {
    const ref = setupSession('manual-switch-invalid-config');
    const task = makeTask({ id: 'T400', status: 'in_progress' });
    const issue = usageLimitIssue(task);
    const state = { ...makeImplState([task]), pendingRecovery: issue };
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });
    writeConfig(ref.projectDir, config);
    writeFileSync(configPath(ref.projectDir), rawYaml);
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      ...ref,
      state,
      bus,
      action: 'switch-seat',
      candidate: { tool: 'claude-code' },
      config,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'fallback-read-failed',
      message: expect.stringContaining('config.yaml does not load'),
    });
    expect(result.state.pendingRecovery).toEqual(issue);
    expect(loadState(ref)?.pendingRecovery).toEqual(issue);
    expect(events).toContainEqual(expect.objectContaining({ type: 'recovery_action_failed' }));
    expect(events.some((event) => event.type === 'seat_switched')).toBe(false);
  });

  it('keeps the declared fallback when a manual command chooses an automatic intent candidate', async () => {
    const ref = setupSession('manual-switch-auto-candidate');
    const task = makeTask({ id: 'T400', status: 'in_progress' });
    const candidate = { tool: 'claude-code' };
    const issue: RecoveryIssue = {
      ...usageLimitIssue(task),
      switchSeat: {
        seat: 'build',
        candidates: [candidate],
        auto: { candidate, configRevision: 'revision' },
      },
    };
    const state = { ...makeImplState([task]), pendingRecovery: issue };
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const result = await applyRecoveryAction({
      ...ref,
      state,
      bus,
      action: 'switch-seat',
      candidate,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex', fallback: candidate } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.switchedConfig?.implementer.fallback).toEqual(candidate);
    expect(result.state.seatSwitches?.[0]?.auto).toBe(false);
  });
  it.each([undefined, 'high'] as const)(
    'records the balance cause when committing an automatic seat switch',
    (variant) => {
      const ref = setupSession('switch-seat-balance');
      const task = makeTask({ id: 'T400', status: 'in_progress' });
      const candidate = {
        tool: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'high',
      } as const;
      const runner = {
        kind: 'cli',
        tool: 'opencode',
        model: 'deepseek/deepseek-flash',
        variant,
        fallback: candidate,
      } as const;
      const issue = buildSeatDownIssue({
        seat: 'build',
        phase: 'implementing',
        task,
        runner,
        classification: { class: 'account', cause: 'balance' },
        words: 'Insufficient Balance',
        createdAt,
        seatSwap: {
          seat: 'build',
          currentTool: 'opencode',
          currentModel: runner.model,
          fallback: candidate,
          detectedTools: [{ ...candidate, ready: true }],
          configRevision: 'revision',
        },
      });
      const state = { ...makeImplState([task]), pendingRecovery: issue };
      saveState(ref, state);
      const { bus, events } = makeBusRecorder();
      const opts = { ...ref, state, bus, config: makeConfig({ implementer: runner }), candidate };
      const planned = planSwitchSeatRecoveryAction(opts);
      expect(planned.ok).toBe(true);
      if (!planned.ok) throw new Error(planned.message);
      const result = commitSeatSwitch({ ...opts, action: 'switch-seat' }, planned.plan, {
        auto: true,
        configRevision: 'revision',
      });

      expect(result.state.seatSwitches?.[0]).toMatchObject({
        from: `OpenCode CLI · deepseek/deepseek-flash${variant === undefined ? '' : ' · high'}`,
        to: 'OpenCode CLI · opencode-go/deepseek-v4.1-flash · high',
        cause: 'runner-usage-limit',
        accountCause: 'balance',
        headline: 'Balance spent on OpenCode CLI',
        auto: true,
      });
      expect(loadState(ref)?.seatSwitches?.[0]).toEqual(result.state.seatSwitches?.[0]);
      expect(
        EngineEventSchema.parse(events.find((event) => event.type === 'seat_switched')),
      ).toMatchObject({
        type: 'seat_switched',
        cause: 'runner-usage-limit',
        accountCause: 'balance',
        headline: 'Balance spent on OpenCode CLI',
        auto: true,
      });
    },
  );

  it('restarts the brief attempt on the chosen tool and returns the switched config', async () => {
    const { projectDir, sessionId } = setupSession('switch-seat-apply');
    const task = makeTask({ id: 'T400', status: 'in_progress' });
    const issue = usageLimitIssue(task);
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const state = { ...base, pendingRecovery: issue };
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'switch-seat',
      bus,
      config: makeConfig(),
      candidate: { tool: 'opencode' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('retry-current-task');
    expect(result.action).toBe('switch-seat');
    expect(result.switchedSeat).toEqual({ seat: 'build', candidate: { tool: 'opencode' } });
    expect(result.switchedConfig?.implementer).toMatchObject({ kind: 'cli', tool: 'opencode' });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.currentTaskIndex).toBe(0);
    expect(result.state.seatSwitches?.[0]).toMatchObject({ seat: 'build', auto: false });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'seat_switched', 'recovery_resolved']),
    );
    // A brief halt moves the seat without resetting the brief the halt named.
    expect(events.map((event) => event.type)).not.toContain('task_reset');
  });

  it('takes the first offered tool when no candidate is named', async () => {
    const { projectDir, sessionId } = setupSession('switch-seat-default');
    const task = makeTask({ id: 'T401', status: 'in_progress' });
    const issue = usageLimitIssue(task);
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: issue },
      action: 'switch-seat',
      bus,
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.switchedSeat?.candidate).toEqual({ tool: 'claude-code' });
  });

  it('blocks a tool the issue never offered', async () => {
    const { projectDir, sessionId } = setupSession('switch-seat-not-offered');
    const task = makeTask({ id: 'T402', status: 'in_progress' });
    const issue = usageLimitIssue(task);
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: issue },
      action: 'switch-seat',
      bus,
      config: makeConfig(),
      candidate: { tool: 'cursor' },
    });

    expect(result).toMatchObject({ ok: false, code: 'candidate-not-offered' });
  });

  it('blocks when the halt carried no seat-swap offer', async () => {
    const { projectDir, sessionId } = setupSession('switch-seat-no-offer');
    const task = makeTask({ id: 'T403', status: 'in_progress' });
    const { switchSeat: _offer, ...withoutOffer } = usageLimitIssue(task);
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: withoutOffer });
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: withoutOffer },
      action: 'switch-seat',
      bus,
      config: makeConfig(),
    });

    expect(result).toMatchObject({ ok: false, code: 'seat-swap-unavailable' });
  });
});

describe('applyRecoveryAction: retry-later', () => {
  function seatDownHalt(resetAt: string | undefined): RecoveryIssue {
    return makeRecoveryIssue({
      reason: 'runner-usage-limit',
      phase: 'final-review',
      seat: 'review',
      ...(resetAt !== undefined && { resetAt }),
      availableActions: ['retry-later', 'end-run'],
      recommendedAction: 'retry-later',
    });
  }

  it('parks the seat on the reset the halt names and clears the halt', async () => {
    const { projectDir, sessionId } = setupSession('retry-later');
    const issue = seatDownHalt('2026-05-01T10:00:00.000Z');
    const base = makeImplState([makeTask({ id: 'T001' })]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: issue },
      action: 'retry-later',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    if (!result.ok) return;
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.seatWait).toEqual({ seat: 'review', resetAt: '2026-05-01T10:00:00.000Z' });
    expect(loadState({ projectDir, sessionId })?.seatWait).toEqual({
      seat: 'review',
      resetAt: '2026-05-01T10:00:00.000Z',
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
  });

  it('blocks when the halt names no reset to wait for', async () => {
    const { projectDir, sessionId } = setupSession('retry-later-no-reset');
    const issue = seatDownHalt(undefined);
    const base = makeImplState([makeTask({ id: 'T001' })]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const { bus } = makeBusRecorder();

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: issue },
      action: 'retry-later',
      bus,
    });

    expect(result).toMatchObject({ ok: false, code: 'action-not-available' });
    expect(result.state.pendingRecovery).toEqual(issue);
    expect(result.state.seatWait).toBeUndefined();
  });

  it('honours a seat wait beyond the rate-limit bound when the run resumes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupSession('retry-later-far');
    const resetAt = '2026-05-01T02:00:00.000Z';
    const issue = seatDownHalt(resetAt);
    const base = makeImplState([makeTask({ id: 'T001' })]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const { bus, events } = makeBusRecorder();

    const applied = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: issue },
      action: 'retry-later',
      bus,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.state.seatWait?.resetAt).toBe(resetAt);

    const pending = resumeSeatWait({
      ref: { projectDir, sessionId, bus },
      state: applied.state,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);
    expect(loadState({ projectDir, sessionId })?.seatWait?.resetAt).toBe(resetAt);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    const resumed = await pending;
    expect(resumed.seatWait).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.seatWait).toBeUndefined();
  });
});

it('records CLI recovery evidence with no workflow mode, even for a run that saved one', async () => {
  const ref = setupSession('skip-saved-mode');
  const state = makeImplState([makeTask({ status: 'failed' })], {
    mode: 'speckit',
    pendingRecovery: makeRecoveryIssue(),
  });
  saveState(ref, state);
  const { bus } = makeBusRecorder();
  const result = await applyRecoveryAction({ ...ref, state, action: 'skip-current-task', bus });
  expect(result.ok).toBe(true);
  expect(readEvidenceLedger(ref)).not.toHaveProperty('mode');
});

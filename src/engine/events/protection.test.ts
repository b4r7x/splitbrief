import { describe, expect, it } from 'vitest';
import { taskId } from '../../core/schemas/task.js';
import { runnerCallWarningFingerprint } from '../calls/warning-fingerprint.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { protectEngineEventForConsumer } from './protection.js';
import type { EngineEvent } from './types.js';

describe('protectEngineEventForConsumer', () => {
  it('drops transcript-only runner payload events when transcript persistence is disabled', () => {
    const event: EngineEvent = {
      type: 'runner_call_text_delta',
      ts: 10,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      channel: 'assistant',
      text: 'secret transcript',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: false }),
    ).toBeNull();
  });

  it('keeps runner activity control metadata but replaces prompt-bearing labels when transcript persistence is disabled', () => {
    const event: EngineEvent = {
      type: 'runner_call_activity',
      ts: 12,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 2,
      activityId: 'call-1:tool:tool-1',
      stage: 'completed',
      kind: 'command',
      label: 'running echo private-runner-output-92741',
      target: 'echo private-runner-output-92741',
      redacted: false,
      rawAvailable: true,
      expandId: 'call-1:tool:tool-1',
    };

    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'ipc',
      persistTranscript: false,
    });

    expect(protectedEvent).toMatchObject({
      type: 'runner_call_activity',
      activityId: 'call-1:tool:tool-1',
      stage: 'completed',
      kind: 'command',
      label: 'running command',
      redacted: true,
      rawAvailable: false,
    });
    expect(protectedEvent).not.toHaveProperty('target');
    expect(protectedEvent).not.toHaveProperty('textPartial');
    expect(protectedEvent).not.toHaveProperty('diagnosticPartial');
    expect(protectedEvent).not.toHaveProperty('expandId');
    expect(JSON.stringify(protectedEvent)).not.toContain('private-runner-output-92741');
  });

  it('redacts canonicalized runner activity before exposing persisted events', () => {
    const event: EngineEvent = {
      type: 'runner_call_activity',
      ts: 14,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 2,
      activityId: 'call-1:warning:1',
      stage: 'warning',
      kind: 'warning',
      label: 'warning stderr',
      diagnosticPartial: 'token sk-\u001b[31mabcdefghijklmnopqrstuvwxyz',
      redacted: false,
      rawAvailable: true,
      expandId: 'call-1:warning:1',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: true }),
    ).toMatchObject({
      type: 'runner_call_activity',
      activityId: 'call-1:warning:1',
      stage: 'warning',
      kind: 'warning',
      label: 'warning stderr',
      diagnosticPartial: 'token sk-***REDACTED***',
      redacted: true,
      rawAvailable: true,
      expandId: 'call-1:warning:1',
    });
  });

  it('preserves runner terminal metadata while omitting error message and native session content', () => {
    const event: EngineEvent = {
      type: 'runner_call_error',
      ts: 20,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
      status: 'failed',
      error: { code: 'failed', message: 'failed with sk-abcdefghijklmnopqrst' },
      partial: true,
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      usage: { inputTokens: 1, outputTokens: 2 },
      nativeSessionId: 'native-secret-session-123',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: false }),
    ).toMatchObject({
      type: 'runner_call_error',
      status: 'failed',
      partial: true,
      durationMs: 10,
      usage: { inputTokens: 1, outputTokens: 2 },
      nativeSessionId: null,
      error: { code: 'failed', message: TRANSCRIPT_OMITTED_MESSAGE },
    });
    expect(
      JSON.stringify(
        protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: false }),
      ),
    ).not.toContain('native-secret-session-123');
  });

  it('removes native session id from completed runner terminal metadata under transcript-off', () => {
    const event: EngineEvent = {
      type: 'runner_call_completed',
      ts: 20,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      usage: null,
      nativeSessionId: 'native-secret-session-123',
    };

    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'ipc',
      persistTranscript: false,
    });

    expect(protectedEvent).toMatchObject({
      type: 'runner_call_completed',
      nativeSessionId: null,
    });
    expect(JSON.stringify(protectedEvent)).not.toContain('native-secret-session-123');
  });

  it('removes standalone runner native session ids under transcript-off', () => {
    const event: EngineEvent = {
      type: 'runner_call_session_id',
      ts: 21,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 3,
      nativeSessionId: 'native-secret-session-456',
    };

    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'ipc',
      persistTranscript: false,
    });

    expect(protectedEvent).toMatchObject({
      type: 'runner_call_session_id',
      nativeSessionId: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(JSON.stringify(protectedEvent)).not.toContain('native-secret-session-456');
  });

  it('removes runner warning raw refs and message-derived fingerprints under transcript-off', () => {
    const rawMessage = 'warning contains private prompt detail';
    const rawFingerprint = runnerCallWarningFingerprint({
      code: 'provider_warning',
      source: 'provider',
      message: rawMessage,
    });
    const event: EngineEvent = {
      type: 'runner_call_warning',
      ts: 22,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 4,
      warning: {
        code: 'provider_warning',
        severity: 'warning',
        source: 'provider',
        surface: 'activity',
        fingerprint: rawFingerprint,
        message: rawMessage,
        rawRef: 'raw-secret-ref-789',
      },
    };

    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'ipc',
      persistTranscript: false,
    });

    expect(protectedEvent).toMatchObject({
      type: 'runner_call_warning',
      warning: {
        code: 'provider_warning',
        fingerprint: expect.stringMatching(/^rw-safe:/),
        message: TRANSCRIPT_OMITTED_MESSAGE,
      },
    });
    if (protectedEvent?.type !== 'runner_call_warning') {
      throw new Error('Expected protected runner warning event');
    }
    expect(protectedEvent.warning.fingerprint).not.toBe(rawFingerprint);
    expect(protectedEvent.warning).not.toHaveProperty('rawRef');
    expect(JSON.stringify(protectedEvent)).not.toContain('raw-secret-ref-789');
    expect(JSON.stringify(protectedEvent)).not.toContain('private prompt detail');
  });

  it('projects paused external-change conflict metadata under transcript-off', () => {
    const rawPath = 'src/private-user-file.ts';
    const event: EngineEvent = {
      type: 'paused_external_changes',
      ts: 23,
      phase: 'implementing',
      selectedAction: 'pause',
      conflict: {
        kind: 'current-task-conflict',
        files: [rawPath],
        affectedTaskIds: [taskId('T001')],
        currentTaskId: taskId('T001'),
        fileConflicts: [
          {
            file: rawPath,
            kind: 'current-task-conflict',
            affectedTaskIds: [taskId('T001')],
          },
        ],
        safeToContinue: false,
        availableActions: ['pause', 'skip-current-task', 'abort-workflow'],
      },
    };

    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'session-log',
      persistTranscript: false,
    });

    expect(protectedEvent).toEqual({
      type: 'paused_external_changes',
      ts: 23,
      phase: 'implementing',
      selectedAction: 'pause',
      conflict: {
        kind: 'current-task-conflict',
        files: [TRANSCRIPT_OMITTED_MESSAGE],
        affectedTaskIds: [taskId('T001')],
        currentTaskId: taskId('T001'),
        fileConflicts: [
          {
            file: TRANSCRIPT_OMITTED_MESSAGE,
            kind: 'current-task-conflict',
            affectedTaskIds: [taskId('T001')],
          },
        ],
        safeToContinue: false,
        availableActions: ['pause', 'skip-current-task', 'abort-workflow'],
      },
    });
    expect(JSON.stringify(protectedEvent)).not.toContain(rawPath);
  });

  it('redacts secrets and strips terminal controls from persisted events', () => {
    const event: EngineEvent = {
      type: 'warning',
      ts: 30,
      phase: 'planning',
      message: 'token sk-abcdefghijklmnopqrst \u001b]0;owned\u0007done',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'session-log', persistTranscript: true }),
    ).toEqual({
      type: 'warning',
      ts: 30,
      phase: 'planning',
      message: 'token sk-***REDACTED*** done',
    });
  });

  it('strips queue previews when transcript persistence is disabled', () => {
    const event: EngineEvent = {
      type: 'message_queued',
      ts: 40,
      phase: 'planning',
      id: 'msg-1',
      preview: 'redacted preview',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'session-log', persistTranscript: false }),
    ).toEqual({
      type: 'message_queued',
      ts: 40,
      phase: 'planning',
      id: 'msg-1',
    });
  });

  it('replaces workflow feature text when transcript persistence is disabled', () => {
    const event: EngineEvent = {
      type: 'workflow_started',
      ts: 45,
      phase: 'planning',
      feature: 'secret feature prompt',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'session-log', persistTranscript: false }),
    ).toEqual({
      type: 'workflow_started',
      ts: 45,
      phase: 'planning',
      feature: TRANSCRIPT_OMITTED_MESSAGE,
    });
  });

  it('omits unsafe operational warning and error messages when transcript persistence is disabled', () => {
    const warning: EngineEvent = {
      type: 'warning',
      ts: 50,
      phase: 'planning',
      message: 'queue full sk-abcdefghijklmnopqrst',
    };
    const error: EngineEvent = {
      type: 'error',
      ts: 51,
      phase: 'planning',
      message: 'ipc failed \u001b[31mhard\u001b[0m',
    };

    expect(
      protectEngineEventForConsumer(warning, { context: 'session-log', persistTranscript: false }),
    ).toEqual({
      type: 'warning',
      ts: 50,
      phase: 'planning',
      message: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(
      protectEngineEventForConsumer(error, { context: 'session-log', persistTranscript: false }),
    ).toEqual({
      type: 'error',
      ts: 51,
      phase: 'planning',
      message: TRANSCRIPT_OMITTED_MESSAGE,
    });
  });

  it('keeps explicitly safe operational warnings actionable when transcript persistence is disabled', () => {
    const warning: EngineEvent = {
      type: 'warning',
      ts: 52,
      phase: 'planning',
      category: 'queue',
      code: 'queue_full',
      transcriptSafe: true,
      message: 'queue full \u001b[31mretry later\u001b[0m',
    };

    expect(
      protectEngineEventForConsumer(warning, { context: 'session-log', persistTranscript: false }),
    ).toEqual({
      type: 'warning',
      ts: 52,
      phase: 'planning',
      category: 'queue',
      code: 'queue_full',
      transcriptSafe: true,
      message: 'queue full retry later',
    });
  });

  it('projects prompt-bearing operational fields while preserving control metadata', () => {
    const sentinel = 'operational-projection-sentinel-64831';
    const events: EngineEvent[] = [
      {
        type: 'planner_status',
        ts: 53,
        phase: 'planning',
        status: 'done',
        summary: `summary ${sentinel}`,
      },
      {
        type: 'validate',
        ts: 54,
        phase: 'implementing',
        taskId: taskId('T001'),
        status: 'done',
        passed: false,
        stages: { typecheck: true, lint: true, test: false },
        commands: { test: `npm test -- ${sentinel}` },
        error: `test failed ${sentinel}`,
        duration: 100,
      },
      {
        type: 'escalate',
        ts: 55,
        phase: 'implementing',
        taskId: taskId('T001'),
        tier: 1,
        hint: `try ${sentinel}`,
      },
      {
        type: 'recovery_action_failed',
        ts: 56,
        phase: 'implementing',
        issueId: 'issue-1',
        reason: 'validation-failed',
        action: 'retry-same-worker',
        message: `blocked ${sentinel}`,
      },
      {
        type: 'implementer_generate_running',
        ts: 57,
        phase: 'implementing',
        taskId: taskId('T001'),
        file: `src/${sentinel}.ts`,
      },
    ];

    const protectedEvents = events.map((event) =>
      protectEngineEventForConsumer(event, { context: 'session-log', persistTranscript: false }),
    );

    expect(JSON.stringify(protectedEvents)).not.toContain(sentinel);
    expect(protectedEvents[0]).toMatchObject({
      type: 'planner_status',
      status: 'done',
      summary: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(protectedEvents[1]).toMatchObject({
      type: 'validate',
      taskId: taskId('T001'),
      status: 'done',
      stages: { typecheck: true, lint: true, test: false },
      error: TRANSCRIPT_OMITTED_MESSAGE,
      duration: 100,
    });
    expect(protectedEvents[1]).not.toHaveProperty('commands');
    expect(protectedEvents[2]).toMatchObject({
      type: 'escalate',
      taskId: taskId('T001'),
      tier: 1,
      hint: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(protectedEvents[3]).toMatchObject({
      type: 'recovery_action_failed',
      issueId: 'issue-1',
      reason: 'validation-failed',
      action: 'retry-same-worker',
      message: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(protectedEvents[4]).toMatchObject({
      type: 'implementer_generate_running',
      taskId: taskId('T001'),
      file: TRANSCRIPT_OMITTED_MESSAGE,
    });
  });

  it('projects task lifecycle prose while preserving task control metadata', () => {
    const sentinel = 'task-lifecycle-sentinel-87231';
    const started: EngineEvent = {
      type: 'task_started',
      ts: 60,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: `title ${sentinel}`,
      index: 0,
      total: 2,
      file: `src/${sentinel}.ts`,
      action: 'modify',
      routingReason: `route ${sentinel}`,
      costPosture: `posture ${sentinel}`,
    };
    const skipped: EngineEvent = {
      type: 'task_skipped',
      ts: 61,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: `skip ${sentinel}`,
      reason: `reason ${sentinel}`,
    };

    const protectedStarted = protectEngineEventForConsumer(started, {
      context: 'session-log',
      persistTranscript: false,
    });
    const protectedSkipped = protectEngineEventForConsumer(skipped, {
      context: 'session-log',
      persistTranscript: false,
    });

    expect(protectedStarted).toMatchObject({
      type: 'task_started',
      taskId: taskId('T001'),
      index: 0,
      total: 2,
      action: 'modify',
      title: TRANSCRIPT_OMITTED_MESSAGE,
      file: TRANSCRIPT_OMITTED_MESSAGE,
      routingReason: TRANSCRIPT_OMITTED_MESSAGE,
      costPosture: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(protectedSkipped).toMatchObject({
      type: 'task_skipped',
      taskId: taskId('T001'),
      title: TRANSCRIPT_OMITTED_MESSAGE,
      reason: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(JSON.stringify([protectedStarted, protectedSkipped])).not.toContain(sentinel);
  });

  it('projects task-review prose while preserving review actions and costs', () => {
    const sentinel = 'task-review-sentinel-49172';
    const event: EngineEvent = {
      type: 'task_review_needed',
      ts: 70,
      phase: 'implementing',
      taskId: taskId('T002'),
      taskTitle: `review ${sentinel}`,
      status: 'recovery-required',
      filesTouched: [`src/${sentinel}.ts`],
      validation: {
        passed: false,
        summary: `validation ${sentinel}`,
        stages: [{ stage: 'test', passed: false, errorSummary: `failed ${sentinel}` }],
      },
      evidence: {
        path: `.diptych/${sentinel}.md`,
        summary: `evidence ${sentinel}`,
        expected: [`expected ${sentinel}`],
        observed: [`observed ${sentinel}`],
      },
      cost: {
        tokenUsage: {
          plannerInput: 1,
          plannerOutput: 2,
          implementerInput: 3,
          implementerOutput: 4,
          escalationInput: 0,
          escalationOutput: 0,
        },
        taskTokens: {
          taskId: taskId('T002'),
          taskTitle: `tokens ${sentinel}`,
          method: 'local',
          implementerTokens: 3,
          escalationTokens: 0,
          retryCount: 1,
          routingReason: `token route ${sentinel}`,
        },
      },
      routing: {
        selectedProfile: 'local-small',
        fit: 'fits',
        estimatedTokens: 10,
        untruncatedEstimatedTokens: 10,
        currentCodeTruncated: false,
        currentCodeContextMode: 'whole-file',
        costPosture: `routing posture ${sentinel}`,
        reason: `routing reason ${sentinel}`,
      },
      recovery: {
        reason: 'validation-failed',
        availableActions: ['retry-same-worker'],
        recommendedAction: 'retry-same-worker',
        message: `recover ${sentinel}`,
      },
      availableCommands: ['continue', 'redo-task', 'edit-notes', 'revise-plan', 'abort'],
    };

    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'session-log',
      persistTranscript: false,
    });

    expect(protectedEvent).toMatchObject({
      type: 'task_review_needed',
      taskId: taskId('T002'),
      status: 'recovery-required',
      taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
      filesTouched: [TRANSCRIPT_OMITTED_MESSAGE],
      validation: {
        summary: TRANSCRIPT_OMITTED_MESSAGE,
        stages: [{ stage: 'test', passed: false, errorSummary: TRANSCRIPT_OMITTED_MESSAGE }],
      },
      evidence: {
        path: TRANSCRIPT_OMITTED_MESSAGE,
        summary: TRANSCRIPT_OMITTED_MESSAGE,
        expected: [TRANSCRIPT_OMITTED_MESSAGE],
        observed: [TRANSCRIPT_OMITTED_MESSAGE],
      },
      routing: {
        selectedProfile: 'local-small',
        fit: 'fits',
        reason: TRANSCRIPT_OMITTED_MESSAGE,
        costPosture: TRANSCRIPT_OMITTED_MESSAGE,
      },
      recovery: {
        reason: 'validation-failed',
        availableActions: ['retry-same-worker'],
        recommendedAction: 'retry-same-worker',
        message: TRANSCRIPT_OMITTED_MESSAGE,
      },
      availableCommands: ['continue', 'redo-task', 'edit-notes', 'revise-plan', 'abort'],
    });
    expect(JSON.stringify(protectedEvent)).not.toContain(sentinel);
  });

  it('projects cost prediction, approval, git commit, and retry prose', () => {
    const sentinel = 'projection-sentinel-63825';
    const events: EngineEvent[] = [
      {
        type: 'cost_prediction',
        ts: 80,
        phase: 'implementing',
        prediction: {
          estimatedTasks: 1,
          lowCost: 0.01,
          expectedCost: 0.02,
          highCost: 0.03,
          plannerTool: 'planner',
          implementerTool: 'worker',
          deterministic: {
            estimateScope: 'prompt-input-only',
            taskCount: 1,
            taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
            contextConfidenceCounts: {
              contextExplicit: 1,
              contextDetected: 0,
              contextKnownCatalog: 0,
              contextCachedProvider: 0,
              contextConservativeFallback: 0,
              profileUnavailable: 0,
            },
            priceConfidenceCounts: {
              priceKnown: 1,
              priceUnknown: 0,
              profileUnavailable: 0,
            },
            tasks: [
              {
                taskId: taskId('T003'),
                title: `cost title ${sentinel}`,
                estimatedPromptTokens: 100,
                selectedProfileId: 'local-small',
                contextFit: 'fits',
                contextConfidence: 'context-explicit',
                priceConfidence: 'price-known',
                estimatedImplementerCost: 0.01,
                hypotheticalPlannerCost: 0.02,
              },
            ],
            totals: {
              knownActualEstimate: 0.01,
              hypotheticalAllPlanner: 0.02,
              estimatedSavings: 0.01,
              unknownCostReason: [],
            },
          },
          plannerEstimateReview: {
            extraPlannerCall: true,
            status: 'completed',
            classification: 'risk',
            affectedTaskIds: ['T003'],
            reason: `review reason ${sentinel}`,
            recommendedUserDecision: `user decision ${sentinel}`,
          },
        },
      },
      {
        type: 'approval_granted',
        ts: 81,
        phase: 'implementing',
        tier: 'confirm',
        actionClass: 'destructive',
        taskId: taskId('T003'),
        scope: 'once',
        confirmReason: `approve ${sentinel}`,
      },
      {
        type: 'approval_rejected',
        ts: 82,
        phase: 'implementing',
        tier: 'confirm',
        actionClass: 'destructive',
        reason: `deny ${sentinel}`,
      },
      {
        type: 'git_commit',
        ts: 83,
        phase: 'implementing',
        taskId: taskId('T003'),
        message: `commit ${sentinel}`,
        file: `src/${sentinel}.ts`,
      },
      {
        type: 'task_retry',
        ts: 84,
        phase: 'implementing',
        taskId: taskId('T003'),
        attempt: 1,
        maxRetries: 2,
        error: `retry ${sentinel}`,
      },
    ];

    const protectedEvents = events.map((event) =>
      protectEngineEventForConsumer(event, { context: 'session-log', persistTranscript: false }),
    );

    expect(protectedEvents[0]).toMatchObject({
      type: 'cost_prediction',
      prediction: {
        deterministic: { tasks: [{ taskId: taskId('T003'), title: TRANSCRIPT_OMITTED_MESSAGE }] },
        plannerEstimateReview: {
          affectedTaskIds: ['T003'],
          reason: TRANSCRIPT_OMITTED_MESSAGE,
          recommendedUserDecision: TRANSCRIPT_OMITTED_MESSAGE,
        },
      },
    });
    expect(protectedEvents[1]).toMatchObject({
      type: 'approval_granted',
      taskId: taskId('T003'),
      scope: 'once',
      confirmReason: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(protectedEvents[2]).toMatchObject({
      type: 'approval_rejected',
      reason: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(protectedEvents[3]).toMatchObject({
      type: 'git_commit',
      taskId: taskId('T003'),
      message: TRANSCRIPT_OMITTED_MESSAGE,
      file: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(protectedEvents[4]).toMatchObject({
      type: 'task_retry',
      taskId: taskId('T003'),
      attempt: 1,
      maxRetries: 2,
      error: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(JSON.stringify(protectedEvents)).not.toContain(sentinel);
  });

  it('projects approval and rewind comments while preserving control metadata', () => {
    const sentinel = 'approval-rewind-comment-sentinel-91462';
    const events: EngineEvent[] = [
      {
        type: 'spec_regenerated',
        ts: 90,
        phase: 'reviewing-spec',
        comment: `approval feedback ${sentinel}`,
      },
      {
        type: 'plan_regenerated',
        ts: 91,
        phase: 'reviewing-plan',
        comment: `plan feedback ${sentinel}`,
      },
      {
        type: 'rewind_to_plan',
        ts: 92,
        phase: 'planning',
        comment: `private rewind direction ${sentinel}`,
      },
    ];

    const protectedEvents = events.map((event) =>
      protectEngineEventForConsumer(event, { context: 'session-log', persistTranscript: false }),
    );

    expect(protectedEvents).toEqual([
      {
        type: 'spec_regenerated',
        ts: 90,
        phase: 'reviewing-spec',
        comment: TRANSCRIPT_OMITTED_MESSAGE,
      },
      {
        type: 'plan_regenerated',
        ts: 91,
        phase: 'reviewing-plan',
        comment: TRANSCRIPT_OMITTED_MESSAGE,
      },
      {
        type: 'rewind_to_plan',
        ts: 92,
        phase: 'planning',
        comment: TRANSCRIPT_OMITTED_MESSAGE,
      },
    ]);
    expect(JSON.stringify(protectedEvents)).not.toContain(sentinel);
  });
});

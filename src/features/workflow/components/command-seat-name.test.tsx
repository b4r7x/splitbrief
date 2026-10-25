import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import {
  makeRunnerCallActivity,
  makeRunnerCallCompleted,
  makeRunnerCallStarted,
} from '#testing/helpers/events/runner-call.js';
import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { taskId } from '../../../core/schemas/task.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { deriveBuildProgress } from '../display/build-progress.js';
import { deriveLiveStatus } from '../display/live-activity.js';
import { deriveRunningSeats } from '../display/running-seats.js';
import {
  formatRecordedSeatChangeIdentities,
  formatRecordedSeatIdentity,
} from '../display/recorded-seat-identity.js';
import { buildActivityBatchViewModel } from '../conversation-rows/activity-batch-model.js';
import { formatTaskStartedParts } from '../conversation-rows/event-format.js';
import { deriveUsageDetails } from '../usage-details-model.js';
import { Sidebar } from './sidebar.js';

const SEATS = [
  {
    kind: 'shell' as const,
    command: './impl.sh',
    swapped: './new.sh',
    model: 'auto',
    name: 'Custom Shell',
    identity: 'Custom Shell · auto',
  },
  {
    kind: 'agent' as const,
    command: 'my-agent',
    swapped: 'other-agent',
    model: 'local-7b',
    name: 'Agent',
    identity: 'Agent · Local 7B',
  },
];

type Seat = (typeof SEATS)[number];

function runnerOf(seat: Seat, command = seat.command) {
  return { kind: seat.kind, command, model: seat.model };
}

function save(seat: Seat, command = seat.command): void {
  configStore.__testReset({
    projectDir: '/tmp/project',
    config: makeConfig({ implementer: runnerOf(seat, command), reviewer: runnerOf(seat, command) }),
  });
}

/** The brief starts the way the engine records it: the brief by kind word, its calls by command. */
function startBrief(seat: Seat): void {
  addEvent({ type: 'workflow_started', ts: 800, phase: 'implementing', feature: 'f' });
  addEvent(
    makeTaskStart({
      ts: 900,
      taskId: taskId('T021'),
      tool: seat.kind,
      model: seat.model,
      axes: [],
      backendKind: seat.kind,
    }),
  );
  addEvent(
    makeRunnerCallStarted({
      ts: 1_000,
      callId: 'call-1',
      taskId: taskId('T021'),
      backendKind: seat.kind,
      runnerName: seat.command,
      model: seat.model,
      axes: [],
    }),
  );
}

function endCall(seat: Seat): void {
  addEvent(
    makeRunnerCallCompleted({
      ts: 2_000,
      callId: 'call-1',
      taskId: taskId('T021'),
      backendKind: seat.kind,
      runnerName: seat.command,
      model: seat.model,
      axes: [],
    }),
  );
}

async function sidebarBuildRow(): Promise<string> {
  const ui = renderFeature(<Sidebar width={50} />);
  await tick();
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame
    .split('\n')
    .filter((line) => line.includes('BUILD'))
    .join(' ');
}

function buildBlockActivity(): string {
  return deriveBuildProgress({
    tasks: tasksStore.get(),
    lifecycle: lifecycleStore.get(),
    operations: operationsStore.get(),
    now: 2_500,
  }).activity;
}

beforeEach(() => resetAllStores());
afterEach(() => resetAllStores());

describe.each(SEATS)('a $kind seat reads one name on every surface', (seat) => {
  it('the sidebar names it the same during a call and between calls', async () => {
    save(seat);
    startBrief(seat);
    const during = await sidebarBuildRow();
    endCall(seat);
    const between = await sidebarBuildRow();

    expect(during).toContain(seat.name);
    expect(during).not.toContain(seat.command);
    expect(between).toContain(seat.name);
  });

  it('the sidebar does not flip when another command of the same kind and model is saved mid-brief', async () => {
    save(seat);
    startBrief(seat);
    save(seat, seat.swapped);
    const during = await sidebarBuildRow();
    endCall(seat);
    const between = await sidebarBuildRow();

    expect(during).toBe(between);
    expect(during).not.toContain(seat.command);
  });

  it('the build block names it by kind during the call', () => {
    save(seat);
    startBrief(seat);

    expect(buildBlockActivity()).toContain(seat.identity);
    expect(buildBlockActivity()).not.toContain(seat.command);
  });

  it('the review byline and the build block name a review call by kind', () => {
    save(seat);
    addEvent({ type: 'workflow_started', ts: 800, phase: 'final-review', feature: 'f' });
    addEvent(
      makeRunnerCallStarted({
        ts: 1_000,
        phase: 'final-review',
        role: 'review',
        backendKind: seat.kind,
        runnerName: seat.command,
        model: seat.model,
        axes: [],
      }),
    );
    const byline = deriveLiveStatus({
      phase: 'final-review',
      status: 'running',
      cancelled: false,
      startedAt: 800,
      phaseFirstSeenTs: {},
      waitedMs: {},
      resumedAt: null,
      reviewerLabel: null,
      plannerCall: null,
      plannerCallStartedTs: null,
      suiteStage: null,
      activeOperation: operationsStore.get().active,
    })
      ?.parts.map((part) => part.text)
      .join('');

    expect(byline).toContain(`Review · ${seat.identity}`);
    expect(buildBlockActivity()).toContain(`Review · ${seat.identity}`);
  });

  it('the transcript brief row and the activity rows name it by kind', () => {
    const briefRow = formatTaskStartedParts(
      makeTaskStart({ tool: seat.kind, model: seat.model, axes: [], backendKind: seat.kind }),
    )
      .map((part) => part.text)
      .join('');
    const activity = buildActivityBatchViewModel({
      batchKey: 'build-batch',
      events: [
        makeRunnerCallActivity('implementer-command', {
          backendKind: seat.kind,
          runnerName: seat.command,
          model: seat.model,
          axes: [],
        }),
      ],
    });

    expect(briefRow).toContain(seat.identity);
    expect(activity.headerRunner).toBe(seat.identity);
  });

  it('a seat-change row names it by kind', () => {
    const row = formatRecordedSeatChangeIdentities(
      { tool: seat.kind, model: seat.model },
      { tool: 'claude-code', model: 'claude-3-5-sonnet' },
      'implementer',
    );

    expect(row.from).toBe(seat.identity);
  });

  it('the recovery title names it by kind', () => {
    const issue = makeRecoveryIssue({
      reason: 'runner-usage-limit',
      seat: 'build',
      facts: { tool: getRunnerCatalogDisplayName(runnerOf(seat)) },
    });

    expect(formatRecoveryHeadline(issue)).toContain(`Usage limit on ${seat.name}`);
  });

  it('/usage names its billing row by kind', () => {
    const view = deriveUsageDetails({
      tokenUsage: null,
      costBreakdown: {
        actualPlannerCost: 0,
        actualImplementerCost: 0,
        totalActualCost: 0,
        providerRunMetadata: {
          [`${seat.kind}:${seat.command}`]: {
            service: seat.kind,
            offering: 'local',
            normalizedEndpoint: `${seat.kind}://${seat.command}`,
            billing: 'unknown',
            asOf: '2026-01-01',
          },
        },
      },
    });

    expect(view.billing.map((row) => row.tool)).toEqual([seat.name]);
  });

  it('the running seat matches the saved seat of the same kind and model', () => {
    const config = makeConfig({ implementer: runnerOf(seat, seat.swapped) });

    expect(
      deriveRunningSeats({
        active: {
          callId: 'call-1',
          role: 'implementer',
          phase: 'implementing',
          label: 'Building',
          status: 'running',
          startedAt: 1_000,
          endedAt: null,
          durationMs: null,
          partial: false,
          reason: null,
          usage: null,
          warnings: [],
          runnerName: seat.command,
          model: seat.model,
          axes: [],
          backendKind: seat.kind,
        },
        config,
        tasks: tasksStore.get(),
        lifecycle: { status: 'running', phase: 'implementing' },
        halted: false,
        cutCallParked: false,
        passSeats: null,
      }),
    ).toEqual({});
  });
});

it('a record kept before kinds were recorded keeps its literal command name', () => {
  expect(
    formatRecordedSeatIdentity({ runnerName: './impl.sh', model: 'auto', role: 'implementer' }),
  ).toBe('./impl.sh · auto');
});

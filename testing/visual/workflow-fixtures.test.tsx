import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { getWorkflowSidebarWidth } from '../../src/features/workflow/layout/rect.js';
import { getWorkflowPromptRows } from '../../src/features/workflow/prompt-rows/workflow.js';
import { approvalPromptStore } from '../../src/stores/approval-prompt/prompt.js';
import { configStore } from '../../src/stores/project/config.js';
import { questionPromptStore } from '../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../src/stores/ui/controls.js';
import { feedbackStore } from '../../src/stores/ui/feedback.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { eventsStore, mergeEventLog } from '../../src/stores/workflow/events.js';
import { lifecycleStore } from '../../src/stores/workflow/lifecycle.js';
import { runViewStore } from '../../src/stores/workflow/run-view.js';
import { recoveryNoticeStore } from '../../src/stores/workflow/recovery-notice.js';
import { operationsStore } from '../../src/stores/workflow/operations/state.js';
import { conversationScrollStore } from '../../src/stores/workflow/conversation-scroll.js';
import { readConversationScrollSnapshot } from '../../src/features/workflow/layout/snapshot.js';
import { flushEffects, tick } from '#testing/helpers/ink.js';
import { reviewStore } from '../../src/stores/workflow/review.js';
import { streamingOutputStore } from '../../src/stores/workflow/streaming-output.js';
import { tokensStore } from '../../src/stores/workflow/tokens.js';
import { selectRunningBrief, selectTaskListView } from '../../src/core/run-view/briefs.js';
import { SOFT_SEP } from '../../src/core/separators.js';
import { glyph } from '../../src/lib/glyphs.js';
import { stripTerminalControls } from '../../src/utils/display-text.js';
import { EngineEventSchema } from '../../src/engine/events/schema.js';
import { deriveRunStatus } from '../../src/core/sessions/run-status.js';
import {
  reviewFindingCounts,
  reviewOutcomeOf,
  reviewOutcomeWord,
} from '../../src/core/review/verdict.js';
import { factSpans, runRows } from '../../src/features/workflow/closed/copy.js';
import { deriveSummaryView } from '../../src/features/workflow/closed/view-model.js';
import { findVisualScenario, REQUIRED_VIEWPORTS, WIDE_VIEWPORTS } from './catalog.js';
import { viewport } from './contracts/geometry.js';
import { scenarioId, type ScenarioId } from './contracts/identifiers.js';
import type { FixtureLifecycle } from './fixtures/common.js';
import { teardownVisualFixture } from './fixtures/screen-fixtures.js';
import {
  getWorkflowFixturePromptRows,
  workflowFixtureProjections,
  type WorkflowFixtureProjection,
} from './fixtures/workflow/projections.js';
import { workflowFixtureRegistry, workflowTranscriptText } from './fixtures/workflow/registry.js';
import { mountGalleryScenario, type GalleryCaptureHandle } from './gallery/mount.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { AGY_QUOTA_LEAD } from '#testing/helpers/events/agy-quota.js';

const VIEWPORT = viewport({ cols: 80, rows: 24 });

it.each([
  'workflow-seat-switched',
  'workflow-seat-switched-manual',
  'workflow-seat-switched-balance',
])('finishes the restarted call and brief in %s', async (id) => {
  const projection = workflowFixtureProjections.get(scenarioId(id));
  if (projection === undefined) throw new Error(`Missing switch scenario ${id}`);
  const events = projection.events;
  const restart = events.findLastIndex((event) => event.type === 'runner_call_started');
  expect(events.slice(restart + 1).map((event) => event.type)).toEqual([
    'runner_call_tool_use',
    'runner_call_activity',
    'planner_text',
    'runner_call_completed',
    'implementer_generate_done',
    'task_completed',
  ]);
  expect(events.find((event) => event.type === 'implementer_generate_done')).toMatchObject({
    files: ['src/text.js', 'test/text.test.js'],
  });
  const lifecycle = await setupProjection(projection);
  try {
    expect(operationsStore.get().active).toBeNull();
    expect(
      selectRunningBrief(runViewStore.get().briefs, runViewStore.get().phase).current,
    ).toBeNull();
    expect(runViewStore.get().briefs.tasks.filter((task) => task.status === 'done')).toHaveLength(
      1,
    );
  } finally {
    await lifecycle.teardown();
  }
});

it.each(['queued', 'delivered', 'steerable'])(
  'uses one Claude Code BUILD seat in the %s queue fixture',
  (state) => {
    const projection = workflowFixtureProjections.get(
      scenarioId(`workflow-implementation-${state}`),
    );
    if (projection === undefined) throw new Error(`Missing ${state} queue fixture`);
    expect(projection.config?.implementer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
    const call = projection.events.find((event) => event.type === 'runner_call_started');
    expect(call).toMatchObject({ backendKind: 'cli', runnerName: 'claude', taskId: 'T003' });
  },
);

it.each(['workflow-continuous-transcript', 'workflow-continuous-transcript-ready'])(
  'records the max effort on every started brief in %s',
  (id) => {
    const projection = workflowFixtureProjections.get(scenarioId(id));
    if (projection === undefined) throw new Error(`Missing scenario ${id}`);
    const starts = projection.events.filter((event) => event.type === 'task_started');
    expect(starts).toHaveLength(id === 'workflow-continuous-transcript' ? 3 : 2);
    for (const event of starts) expect(event.axes).toEqual(['max']);
  },
);

it.each(['workflow-attempt-reverted', 'workflow-attempt-reverted-checkout'])(
  'halts %s on a git change during the call, in the words the product writes',
  (id) => {
    const projection = workflowFixtureProjections.get(scenarioId(id));
    if (projection === undefined) throw new Error(`Missing scenario ${id}`);
    const started = projection.events.find((event) => event.type === 'task_started');
    const failed = projection.events.find((event) => event.type === 'implementer_generate_failed');
    if (
      started?.type !== 'task_started' ||
      failed?.type !== 'implementer_generate_failed' ||
      failed.error === undefined
    ) {
      throw new Error(`Missing the brief start or the BUILD failure in ${id}`);
    }
    const halt = projection.resumeState?.pendingRecovery;
    expect.soft(halt?.reason).toBe('checkout-changed');
    expect.soft(halt?.files).toEqual([]);
    expect(halt?.message).toBe(`Repository changed under ${started.taskId} · ${failed.error}`);
  },
);

it.each([
  'workflow-recovery-left-isolation',
  'workflow-recovery-left-isolation-in-place',
  'workflow-at-rest-left-isolation',
])('halts %s on a write outside the workspace, in the words the product writes', (id) => {
  const projection = workflowFixtureProjections.get(scenarioId(id));
  if (projection === undefined) throw new Error(`Missing scenario ${id}`);
  const hydration = projection.atRest?.record.hydration;
  const halt =
    hydration?.kind === 'loaded'
      ? hydration.state.pendingRecovery
      : projection.resumeState?.pendingRecovery;
  const evidence = halt?.details[0] ?? '';
  expect
    .soft(evidence)
    .toMatch(/^Google Antigravity CLI wrote to \S+ \(outside the workspace\) with run_command: /);
  expect(halt?.message).toBe(`${halt?.taskId} left the isolation directory${SOFT_SEP}${evidence}`);
});

it('logs the error row of the at-rest left-isolation halt as the product writes it', () => {
  const projection = workflowFixtureProjections.get(scenarioId('workflow-at-rest-left-isolation'));
  const route = projection?.atRest;
  if (route === undefined || typeof route.log !== 'string') {
    throw new Error('Missing at-rest left-isolation log');
  }
  const hydration = route.record.hydration;
  if (hydration.kind !== 'loaded') throw new Error('Missing loaded left-isolation state');
  const halt = hydration.state.pendingRecovery;
  const messages = readFileSync(resolve(process.cwd(), route.log), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'error')
    .map((entry) => entry.data.message);
  expect(messages).toEqual([halt?.message]);
});

it('names one BUILD seat in the header and in the halt of the left-isolation frame', async () => {
  const scenario = findVisualScenario('workflow-at-rest-left-isolation');
  const checkpoint = scenario?.checkpoints[0];
  if (scenario === undefined || checkpoint === undefined) {
    throw new Error('Missing at-rest left-isolation scenario');
  }
  const ui = await mountGalleryScenario({
    scenario,
    checkpoint,
    viewport: viewport({ cols: 120, rows: 40 }),
  });
  try {
    const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
      preserveLineBreaks: true,
    });
    const header = frame.split('\n')[0] ?? '';
    expect(header.split('BUILD')).toHaveLength(2);
    expect(header).toContain('BUILD Gemini 3 Flash');
    const transcript = workflowTranscriptText().replace(/\s+/g, ' ');
    expect(transcript).toContain('left the isolation directory');
    expect(transcript).toContain('Google Antigravity CLI wrote to');
    expect(frame).not.toContain('Qwen2.5 Coder 7B');
  } finally {
    await ui.unmount();
  }
});

it('counts the saved final review in the packet and the Review row of every closed run', () => {
  const disagreements: string[] = [];
  for (const projection of workflowFixtureProjections.values()) {
    const record = projection.atRest?.record;
    const packet = record?.summary?.reviewPacket;
    if (record?.status.kind !== 'closed' || packet?.finalReviewStatus !== 'written') continue;
    const id = projection.scenarioId;
    const review = record.hydration.kind === 'loaded' ? record.hydration.state.review : undefined;
    if (review === undefined || review.scope === 'task') {
      disagreements.push(`${id}: the packet is written but the state saves no final review`);
    } else {
      const outcome = reviewOutcomeOf(review);
      const saved = { verdict: reviewOutcomeWord(outcome), counts: reviewFindingCounts(outcome) };
      const packed = {
        verdict: packet.finalReviewVerdict,
        counts: packet.finalReviewFindingCounts,
      };
      if (!isDeepStrictEqual(packed, saved)) {
        disagreements.push(
          `${id}: packet ${JSON.stringify(packed)}, review ${JSON.stringify(saved)}`,
        );
      }
    }
    const view = deriveSummaryView({ record });
    const reviewRow =
      view === null ? undefined : runRows(view).find((row) => row.seat === 'review');
    if (view === null || reviewRow === undefined) {
      disagreements.push(`${id}: the closed summary has no Review row`);
      continue;
    }
    const notesFact = reviewRow.segments
      .flatMap((fact) => factSpans(fact).map((span) => span.text))
      .find((text) => /^\d+ notes?$/.test(text));
    const counted = notesFact === undefined ? 0 : Number.parseInt(notesFact, 10);
    if (counted !== view.digest.notes.length) {
      disagreements.push(
        `${id}: the Review row counts ${counted} notes, the summary quotes ${view.digest.notes.length}`,
      );
    }
  }
  expect(disagreements).toEqual([]);
});

function lifecycleFor(scenarioId: ScenarioId): FixtureLifecycle {
  const factory = workflowFixtureRegistry.get(scenarioId);
  if (!factory) throw new Error(`Missing workflow fixture ${scenarioId}`);
  return factory();
}

async function scrollTranscript(
  ui: GalleryCaptureHandle,
  markers: readonly string[],
): Promise<string> {
  let snapshot = readConversationScrollSnapshot();
  while (snapshot.scrollOffset < snapshot.maxOffset) {
    ui.stdin.write('\u001b[5~');
    await tick(20);
    const next = readConversationScrollSnapshot();
    expect(next.scrollOffset).toBeGreaterThan(snapshot.scrollOffset);
    snapshot = next;
  }
  const reached = [stripTerminalControls(ui.lastFrame() ?? '', { preserveLineBreaks: true })];
  const rows = conversationScrollStore.get().scrollOffset;
  for (
    let row = 0;
    row < rows && !markers.every((marker) => reached.join('\n').includes(marker));
    row++
  ) {
    ui.stdin.write('\u001b[1;2B');
    await tick(20);
    reached.push(stripTerminalControls(ui.lastFrame() ?? '', { preserveLineBreaks: true }));
  }
  return reached.join('\n');
}

async function setupProjection(projection: WorkflowFixtureProjection): Promise<FixtureLifecycle> {
  const scenario = findVisualScenario(projection.scenarioId);
  if (!scenario) throw new Error(`Missing workflow scenario ${projection.scenarioId}`);
  const checkpoint = scenario.checkpoints[0];
  if (!checkpoint) throw new Error(`Missing workflow checkpoint ${projection.scenarioId}`);
  const lifecycle = lifecycleFor(projection.scenarioId);
  await lifecycle.setup({ scenario, checkpoint, viewport: VIEWPORT });
  return lifecycle;
}

interface CapturedGalleryFrame {
  readonly frame: string;
  readonly feedback: ReturnType<typeof feedbackStore.get>;
  readonly events: ReturnType<typeof eventsStore.get>['events'];
}

async function captureGalleryFrame(id: string, cols = 120): Promise<CapturedGalleryFrame> {
  const scenario = findVisualScenario(id);
  const checkpoint = scenario?.checkpoints[0];
  const renderViewport =
    scenario?.viewports.find((value) => value.cols === cols) ?? scenario?.viewports[0];
  if (scenario === undefined || checkpoint === undefined || renderViewport === undefined) {
    throw new Error(`Missing gallery frame ${id}`);
  }
  const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
  try {
    const frame = stripAnsiStyles(await handle.waitForCheckpoint());
    return { frame, feedback: feedbackStore.get(), events: eventsStore.get().events };
  } finally {
    await handle.unmount();
  }
}

function startsWithText(frame: string, text: string): boolean {
  return frame.split('\n').some((line) => line.trimStart().startsWith(text));
}

async function renderProjection(projection: WorkflowFixtureProjection): Promise<string> {
  const scenario = findVisualScenario(projection.scenarioId);
  if (!scenario) throw new Error(`Missing workflow scenario ${projection.scenarioId}`);
  const checkpoint = scenario.checkpoints[0];
  const selectedViewport =
    scenario.viewports.find(
      (value) => value.cols === VIEWPORT.cols && value.rows === VIEWPORT.rows,
    ) ?? scenario.viewports[0];
  if (!checkpoint || !selectedViewport)
    throw new Error(`Missing workflow checkpoint or viewport ${projection.scenarioId}`);
  let ui: GalleryCaptureHandle | null = null;
  try {
    ui = await mountGalleryScenario({ scenario, checkpoint, viewport: selectedViewport });
    const frame = await ui.waitForCheckpoint();
    expect(controlsStore.get().inputMode).toBe(projection.inputMode);
    expect(controlsStore.get().sidebarVisible).toBe(projection.sidebarVisible);
    if (projection.atRest === undefined) {
      // A resumed halt republishes its own prompt through the recovery driver, so
      // that one event belongs to production, not to the projection's event list. A run that
      // resumes and halts publishes its own events, its prompt among them.
      const consultAnswer =
        projection.scenarioId === 'workflow-consult-answer-default' ||
        projection.scenarioId === 'workflow-consult-answer-typed';
      const drivenEvents =
        (projection.resumeState?.pendingRecovery === undefined ? 0 : 1) +
        (consultAnswer ? 1 : 0) +
        (projection.resumedRun?.events.length ?? 0) +
        (projection.nextPassEvents?.length ?? 0);
      expect(eventsStore.get().events).toHaveLength(
        mergeEventLog([...projection.events]).length + drivenEvents,
      );
    } else {
      // A run at rest stages no events: its transcript is its own history, and the replay
      // brackets whatever the run wrote with the two markers that say where it came from.
      const types = eventsStore.get().events.map((event) => event.type);
      expect(types[0], projection.scenarioId).toBe('replay_started');
      expect(types.at(-1), projection.scenarioId).toBe('replay_complete');
    }
    if (projection.review !== undefined) {
      // A document gate is its own panel; only the tiered gates go through the approval store.
      if (projection.reviewArtifact === undefined) {
        expect(approvalPromptStore.get().status).toBe('pending');
      }
      expect(questionPromptStore.get().hint).toBeNull();
      expect(getWorkflowFixturePromptRows(projection, selectedViewport.cols)).toBeGreaterThan(0);
    }
    return frame;
  } finally {
    await ui?.unmount();
  }
}

describe('workflow visual fixtures', () => {
  it('puts each event the review retry adds after the last event of the final review', () => {
    const base = workflowFixtureProjections.get(scenarioId('workflow-final-review'));
    const retry = workflowFixtureProjections.get(scenarioId('workflow-final-review-seat-retry'));
    if (base === undefined) throw new Error('Missing final review scenario');
    if (retry === undefined) throw new Error('Missing final review seat retry scenario');
    const baseEvents = base.events;
    const maxBaseTs = Math.max(...baseEvents.map((event) => event.ts));
    const addedEvents = retry.events.slice(baseEvents.length);
    expect(addedEvents.length).toBeGreaterThan(0);
    for (const event of addedEvents) {
      expect(event.ts).toBeGreaterThan(maxBaseTs);
    }
  });

  it('builds the review-unverified halt as the production halt builds it', () => {
    const projection = workflowFixtureProjections.get(
      scenarioId('workflow-recovery-review-unverified'),
    );
    if (projection === undefined) throw new Error('Missing review-unverified recovery scenario');
    expect(projection.resumeState?.pendingRecovery?.details).toEqual([
      'Planner said: No fix brief can verify these criteria: each one needs a person to try the app.',
      'Unverified criteria: C1, C2, C3, C4, C5, C6',
    ]);
    expect(projection.resumeState?.pendingRecovery?.availableActions).toContain('decide-for-me');
  });

  it('offers an inherited REVIEW its own seat and explains the switch', async () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-recovery-review-seat'));
    if (projection === undefined) throw new Error('Missing inherited REVIEW recovery scenario');
    expect(projection.resumeState?.pendingRecovery).toMatchObject({
      seat: 'review',
      switchSeat: { seat: 'review' },
    });
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(frame).toContain('Change REVIEW tool');
    expect(frame).toContain('REVIEW = PLAN. Switching here gives REVIEW its own seat.');
    expect(frame).not.toContain('Change PLAN tool');
  });

  it('names a REVIEW model refusal by the model and offers another model on its own tool', async () => {
    const projection = workflowFixtureProjections.get(
      scenarioId('workflow-recovery-review-model-not-listed'),
    );
    if (projection === undefined) throw new Error('Missing REVIEW model refusal scenario');
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(frame).toContain('Seat down · Model not listed by OpenCode CLI');
    expect(frame).toContain('Pick another REVIEW model');
    expect(frame).not.toContain('Change REVIEW tool');
  });

  it('renders a REVIEW contract halt with multiple errors in the transcript and panel', async () => {
    const projection = workflowFixtureProjections.get(
      scenarioId('workflow-recovery-review-contract'),
    );
    if (projection === undefined) throw new Error('Missing REVIEW contract recovery scenario');
    expect(projection.resumeState?.pendingRecovery).toMatchObject({
      seat: 'review',
      reason: 'seat-protocol-error',
    });
    const frame = stripTerminalControls(await renderProjection(projection), {
      preserveLineBreaks: true,
    }).replace(/[│\s]+/g, ' ');
    expect(frame).toContain(
      'The reviewer seat answer did not match its contract after 2 attempts.',
    );
    expect(frame).toContain(
      'result.checks.0.value: The check command contains a shell operator. Choose a single command.',
    );
    expect(frame).toContain('result.verdict: Required');
  });

  it.each([
    [
      'workflow-recovery-review-prompt-too-large',
      'Review input too large for OpenAI Codex CLI',
      'Review input is 1,106,026 characters; OpenAI Codex CLI takes at most 1,048,576.',
      'Change REVIEW tool',
    ],
    [
      'workflow-recovery-build-prompt-too-large',
      'Prompt too large for OpenAI Codex CLI on T001',
      'The prompt is 1,106,026 characters; OpenAI Codex CLI takes at most 1,048,576.',
      'Change BUILD tool',
    ],
  ])(
    "%s states the tool's prompt limit in plain words, with a tool change and no retry",
    async (id, title, detail, change) => {
      const projection = workflowFixtureProjections.get(scenarioId(id));
      if (projection === undefined) throw new Error(`Missing ${id} scenario`);
      const frame = stripTerminalControls(await renderProjection(projection), {
        preserveLineBreaks: true,
      }).replace(/[│\s]+/g, ' ');
      expect(frame).toContain(title);
      expect(frame).toContain(detail);
      expect(frame).toContain(change);
      expect(frame).not.toContain('Try again');
      expect(frame).not.toMatch(/argv|command line|reported:|Context overflow/);
    },
  );

  it('names a BUILD prompt refused as too large and its brief once, with no Recovery row restating it', async () => {
    const projection = workflowFixtureProjections.get(
      scenarioId('workflow-recovery-build-prompt-too-large'),
    );
    if (projection === undefined) throw new Error('Missing BUILD prompt-too-large scenario');
    const frame = stripTerminalControls(await renderProjection(projection), {
      preserveLineBreaks: true,
    }).replace(/[│\s]+/g, ' ');
    expect(frame).toContain('Seat down · Prompt too large for OpenAI Codex CLI on T001');
    expect(frame).not.toContain('after 1 attempt');
    expect(frame).not.toContain('Recovery Prompt too large');
  });

  it('names the refused prompt and its tool in the byline of a run parked at that halt', async () => {
    const projection = workflowFixtureProjections.get(
      scenarioId('workflow-at-rest-prompt-too-large'),
    );
    if (projection === undefined) throw new Error('Missing at-rest prompt-too-large scenario');
    const frame = stripTerminalControls(await renderProjection(projection), {
      preserveLineBreaks: true,
    }).replace(/[│\s]+/g, ' ');
    expect(frame).toContain('Seat down · Prompt too large for OpenAI Codex CLI on T002');
    expect(frame).not.toMatch(/argv|Context overflow/);
  });

  it.each([
    ['workflow-recovery-no-fallback', 'no fallback set'],
    [
      'workflow-recovery-fallback-used',
      'fallback: OpenCode CLI · DeepSeek V4.1 Flash · via deepseek · automatic switch already used in this run',
    ],
    [
      'workflow-recovery-fallback-not-installed',
      'fallback: OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · max · not offered: not installed',
    ],
  ])('renders the fallback detail and BUILD action for %s', async (id, detail) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const projection = workflowFixtureProjections.get(scenarioId(id));
    if (!scenario || !checkpoint || !projection) throw new Error(`Missing scenario ${id}`);
    const state = projection.resumeState;
    const issue = state?.pendingRecovery;
    expect(issue?.seat).toBe('build');
    expect(issue?.reason).toBe('runner-usage-limit');
    expect(issue?.details?.some((row) => row.includes(detail))).toBe(true);
    expect(issue?.switchSeat?.auto).toBeUndefined();
    if (id === 'workflow-recovery-no-fallback') {
      expect(projection.config?.implementer?.fallback).toBeUndefined();
    } else {
      expect(issue?.details?.some((row) => row.startsWith('fallback: '))).toBe(true);
    }
    if (id === 'workflow-recovery-fallback-used') {
      expect(state?.seatSwitches).toContainEqual(
        expect.objectContaining({ seat: 'build', auto: true }),
      );
    }
    if (id === 'workflow-recovery-fallback-not-installed') {
      expect(issue?.switchSeat?.candidates.some((candidate) => candidate.tool === 'opencode')).toBe(
        false,
      );
    }
    for (const renderViewport of REQUIRED_VIEWPORTS) {
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        }).replace(/[│\s]+/g, ' ');
        expect(frame).toContain('Seat down');
        expect(frame).toContain('Change BUILD tool');
        if (renderViewport.rows >= 24) expect(frame).toContain(detail);
      } finally {
        await ui.unmount();
      }
    }
  });

  it.each([
    ['workflow-seat-switched', true],
    ['workflow-seat-switched-manual', false],
  ])('renders the recorded automatic flag for %s', async (id, auto) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const projection = workflowFixtureProjections.get(scenarioId(id));
    if (!scenario || !checkpoint || !projection) throw new Error(`Missing scenario ${id}`);
    expect(projection.events.find((event) => event.type === 'seat_switched')).toMatchObject({
      seat: 'build',
      auto,
    });
    for (const renderViewport of REQUIRED_VIEWPORTS) {
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint()).replace(/\s+/g, ' ');
        expect(frame).toContain('BUILD OpenCode CLI · DeepSeek V4.1 Flash · via deepseek');
        expect(frame).toContain('→ OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go');
        expect(frame).toContain('high');
        expect(frame.includes('automatic fallback')).toBe(auto);
        expect(frame).toContain('Balance spent on deepseek (OpenCode CLI)');
        expect(frame).not.toContain('usage limit');
      } finally {
        await ui.unmount();
      }
    }
  });

  it('replays the recorded spent-b2 warning and completions without file lists', async () => {
    const scenario = findVisualScenario('workflow-spent-b2-replay');
    const checkpoint = scenario?.checkpoints[0];
    const projection = workflowFixtureProjections.get(scenarioId('workflow-spent-b2-replay'));
    if (!scenario || !checkpoint || !projection) throw new Error('Missing spent-b2 replay');
    const record = projection.atRest?.record;
    if (record?.hydration.kind !== 'loaded') throw new Error('Missing spent-b2 saved state');
    expect(record.status).toEqual(
      deriveRunStatus({ reviewNone: false, state: record.hydration.state, liveness: 'not-alive' }),
    );
    expect(record.status).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
      resumeAt: { kind: 'review', cycle: 0 },
    });
    expect(projection.events).toHaveLength(66);
    expect(projection.events.filter((event) => event.type === 'implementer_generate_done')).toEqual(
      [
        expect.objectContaining({ taskId: 'T001', file: 'src/text.js', duration: 15409 }),
        expect.objectContaining({ taskId: 'T002', file: 'src/preview.js', duration: 15018 }),
      ],
    );
    for (const event of projection.events.filter(
      (event) => event.type === 'implementer_generate_done',
    ))
      expect(event).not.toHaveProperty('files');
    for (const renderViewport of scenario.viewports) {
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripAnsiStyles(await ui.waitForCheckpoint());
        const text = workflowTranscriptText();
        expect(text.match(/BUILD activity {2}5 updates/g)).toHaveLength(1);
        expect(text.match(/BUILD activity {2}4 updates/g)).toHaveLength(1);
        // Only the lowest fold of the transcript names the activity key.
        expect(text.match(/\+2 earlier$/gm)).toHaveLength(1);
        expect(text.match(/\+1 earlier · ctrl\+a/g)).toHaveLength(1);
        expect(text.match(/ctrl\+a/g)).toHaveLength(1);
        expect(frame).toContain('● Plan → × Build → ○ Review');
        if (renderViewport.cols === 200) expect(frame).toContain('Stopped before the review');
        expect(text.match(/Recovery {2}/g)).toHaveLength(1);
        for (const stale of [
          'Warning',
          'BUILD seat changed',
          'Add credit',
          'Change BUILD tool',
          'working on',
        ])
          expect(text).not.toContain(stale);
        expect(text.match(/Report {2}done$/gm)).toHaveLength(2);
        for (const name of ['text', 'preview']) {
          const line = text.split('\n').find((row) => row.startsWith(`src/${name}.js ·`));
          expect(line?.split(`src/${name}.js`)).toHaveLength(2);
          expect(line?.split(`test/${name}.test.js`)).toHaveLength(2);
        }
        expect(operationsStore.get().active).toBeNull();
        expect(selectTaskListView(runViewStore.get().briefs)).toMatchObject({
          passed: 2,
          total: 2,
        });
      } finally {
        await ui.unmount();
      }
    }
  });

  it.each([120, 60])('expands and collapses recovery with ctrl+d at %s columns', async (cols) => {
    const scenario = findVisualScenario('workflow-seat-switched');
    const checkpoint = scenario?.checkpoints.find(
      (value) => value.id === 'seat-switched-expanded-recovery',
    );
    const renderViewport = scenario?.viewports.find((value) => value.cols === cols);
    if (!scenario || !checkpoint || !renderViewport) throw new Error('Missing expanded recovery');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
    try {
      await ui.waitForCheckpoint();
      expect(workflowTranscriptText()).toContain('provider.quota: Insufficient Balance');
      expect(workflowTranscriptText()).toContain('ctrl+d to collapse');
      ui.stdin.write('\u0004');
      await tick(20);
      expect(workflowTranscriptText()).not.toContain('provider.quota: Insufficient Balance');
      expect(workflowTranscriptText()).not.toContain('ctrl+d to collapse');
      expect(workflowTranscriptText().match(/Recovery {2}/g)).toHaveLength(1);
    } finally {
      await ui.unmount();
    }
  });

  it.each([
    ['consult-quota-fallback', false],
    ['consult-quota-fallback-expanded-recovery', true],
  ])(
    'folds the usage limit of a consult that moved PLAN to its fallback at %s',
    async (id, expanded) => {
      const scenario = findVisualScenario('workflow-consult-quota-fallback');
      const checkpoint = scenario?.checkpoints.find((value) => value.id === id);
      if (!scenario || !checkpoint) throw new Error(`Missing consult usage limit checkpoint ${id}`);
      for (const renderViewport of scenario.viewports) {
        const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
        try {
          await ui.waitForCheckpoint();
          const transcript = workflowTranscriptText().replace(/\s+/g, ' ');
          expect(transcript).toContain('Recovery Usage limit on Google Antigravity CLI');
          expect(transcript).toContain('continued on fallback');
          expect(workflowTranscriptText().match(/Recovery {2}/g)).toHaveLength(1);
          expect(transcript.includes(AGY_QUOTA_LEAD)).toBe(expanded);
          expect(transcript.includes('ctrl+d to collapse')).toBe(expanded);
        } finally {
          await ui.unmount();
        }
      }
    },
  );

  it.each(WIDE_VIEWPORTS)(
    'counts out-of-scope task review notes at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-review-task-out-of-scope');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing out-of-scope review scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        const row = frame.split('\n').find((line) => line.includes('Review T001 passed'));
        expect(row).toContain('3 notes');
        expect(frame).not.toContain('0 notes');
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each([
    [60, 10, 'write src/features/workflow/components/approval-promp…'],
    [60, 12, 'write src/features/workflow/components/approval-promp…'],
    [80, 12, 'write src/features/workflow/components/approval-prompt/confirm-panel-long…'],
  ])('marks the cut path of the confirm gate at %ix%i', async (cols, rows, subject) => {
    const scenario = findVisualScenario('workflow-approval-confirm-long-path');
    const checkpoint = scenario?.checkpoints[0];
    const renderViewport = scenario?.viewports.find(
      (value) => value.cols === cols && value.rows === rows,
    );
    if (!scenario || !checkpoint || !renderViewport) throw new Error('Missing long-path confirm');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
    try {
      const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
        preserveLineBreaks: true,
      });
      const row = frame.split('\n').find((line) => line.includes('write src/features/workflow'));
      expect(row).toContain(subject);
    } finally {
      await ui.unmount();
    }
  });

  it("shows the planner's cannot answer on the skipped brief as cannot be done", async () => {
    const scenario = findVisualScenario('workflow-closed-decided-skip');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing decided-skip scenario');
    const ui = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: viewport({ cols: 120, rows: 40 }),
    });
    try {
      const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
        preserveLineBreaks: true,
      });
      expect(frame).toContain(
        'PLAN → T002: cannot be done · The form file is generated; every attempt is overwritten by the build.',
      );
    } finally {
      await ui.unmount();
    }
  });

  it('models the smoke narration as marked chunks and retains the completed brief body', () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-continuous-transcript'));
    if (!projection) throw new Error('Missing continuous transcript scenario');
    for (const event of projection.events)
      expect(EngineEventSchema.safeParse(event).success, event.type).toBe(true);
    const chunks = projection.events
      .filter((event) => event.type === 'planner_text')
      .filter((event) => event.role === 'implementer');
    expect(chunks.slice(0, 5).map((event) => event.text)).toEqual([
      'Implemented `lowStockItems` and `restockPlan` in',
      ' [src/report.js](file:///Users/x',
      '/.local/state/splitbrief/trees/42',
      '/run/src/report.js)',
      ' and added tests.\n',
    ]);
    for (const chunk of chunks) expect(chunk.content).toBe('markdown');
    expect(
      projection.events.filter(
        (event) => event.type === 'runner_call_activity' && event.taskId === 'T001',
      ),
    ).toHaveLength(5);
    const merged = mergeEventLog([...projection.events]);
    expect(merged).toContainEqual(
      expect.objectContaining({
        type: 'planner_text',
        role: 'implementer',
        text: expect.stringContaining('src/report.js) and added tests.'),
      }),
    );
  });

  it.each(REQUIRED_VIEWPORTS)(
    'keeps the completed body and running brief reachable at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-continuous-transcript');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing continuous transcript checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const live = await ui.waitForCheckpoint();
        expect(live).toContain('npm test');
        const markers = [
          '● Plan',
          '● T001',
          'lowStockItems',
          '+2 earlier · ctrl+a',
          'Report  done',
          'Validate',
          'Fix check V1',
          'Keep the stock warning',
          '● T002',
          '◉ T003',
        ];
        const history = await scrollTranscript(ui, markers);
        for (const marker of markers) expect(history).toContain(marker);
        if (renderViewport.cols <= 120)
          expect(history.indexOf('● Plan')).toBeLessThan(history.indexOf('● T001'));
        expect(history.indexOf('● T001')).toBeLessThan(history.indexOf('lowStockItems'));
        expect(history).toContain('src/report.js');
        expect(history).not.toContain('](file:');
        expect(history).not.toContain('`lowStockItems`');
        expect(history).not.toContain('working on T001');
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each(['workflow-review-task-cadence', 'workflow-review-task-cadence-settled'])(
    'renders %s with each review below its brief',
    async (id) => {
      const projection = workflowFixtureProjections.get(scenarioId(id));
      if (projection === undefined) throw new Error('Missing task cadence scenario');
      const scenario = findVisualScenario(id);
      const checkpoint = scenario?.checkpoints[0];
      if (scenario === undefined || checkpoint === undefined)
        throw new Error('Missing task cadence checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        const lines = workflowTranscriptText().split('\n');
        const first = lines.findIndex((line) => line.includes('● T001'));
        const firstReview = lines.findIndex((line) => line.includes('● Review T001 passed'));
        const second = lines.findIndex((line) => line.includes('● T002'));
        expect(first).toBeGreaterThanOrEqual(0);
        expect(firstReview).toBeGreaterThan(first);
        expect(second).toBeGreaterThan(firstReview);
        expect(lines.filter((line) => line.includes('Review T001 passed'))).toHaveLength(1);
        if (projection.atRest === undefined) {
          expect(frame).toContain('Review · Reviewer check V1 · npm test');
          expect(frame).toContain('Reviewer check V1');
          expect(frame).toContain('running 0:35');
          expect(
            projection.events.findLast((event) => event.type === 'review_started'),
          ).toMatchObject({
            scope: 'task',
            afterTaskId: 'T002',
            tool: 'codex',
            model: 'gpt-6.1-sol',
            axes: ['high'],
          });
        } else {
          expect(lines.filter((line) => /review/i.test(line))).toEqual(
            expect.arrayContaining([
              expect.stringContaining('✗ Review T002 failed  1 blocking · fixes T003 · 49.0s'),
              expect.stringContaining('● Review T002 passed  49.0s'),
              expect.stringContaining('● Final review after 1 fix cycle passed  1m 2s'),
            ]),
          );
          expect(
            lines.filter((line) => line.includes('Final review after 1 fix cycle passed')),
          ).toHaveLength(1);
          expect(frame).not.toContain('running 0:');
        }
      } finally {
        await ui.unmount();
      }
    },
  );

  it('shows four unverified criteria on the settled failed review row', async () => {
    const scenario = findVisualScenario('workflow-review-settled-unverified');
    const checkpoint = scenario?.checkpoints[0];
    if (scenario === undefined || checkpoint === undefined) {
      throw new Error('Missing settled unverified review scenario');
    }
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      await ui.waitForCheckpoint();
      const completed = eventsStore.get().events.find((event) => event.type === 'review_completed');
      expect(completed).toMatchObject({
        verdict: 'fail',
        findings: { blocking: 0, minor: 0, outOfScope: 0, unverifiedCriteria: 4 },
      });
      expect(workflowTranscriptText()).toContain('✗ Final review failed  4 unverified criteria');
    } finally {
      await ui.unmount();
    }
  });

  it.each([true, false])(
    'shows the narrow rail fraction only with the build block down %s',
    async (blockDown) => {
      const scenario = findVisualScenario('workflow-review-fix-narrow-rail');
      const checkpoint = scenario?.checkpoints[blockDown ? 1 : 0];
      const selectedViewport = scenario?.viewports[0];
      if (!scenario || !checkpoint || !selectedViewport)
        throw new Error('Missing narrow rail checkpoint');
      const handle = await mountGalleryScenario({
        scenario,
        checkpoint,
        viewport: selectedViewport,
      });
      try {
        const frame = stripTerminalControls(await handle.waitForCheckpoint());
        const rail = frame.split('\n')[0];
        if (blockDown) {
          expect(rail).toContain('● Build  4/7 passed');
          expect(frame).not.toContain('4/7 briefs passed');
        } else {
          expect(rail).toContain('● Build');
          expect(rail).not.toContain('4/7 passed');
          expect(frame).toContain('4/7 briefs passed');
        }
      } finally {
        await handle.unmount();
      }
    },
  );

  it.each([
    [60, 18],
    [80, 24],
  ])('names the running stage of the first brief after a plan at %ix%i', async (cols, rows) => {
    const scenario = findVisualScenario('workflow-first-brief-after-plan');
    const checkpoint = scenario?.checkpoints[0];
    const renderViewport = scenario?.viewports.find(
      (value) => value.cols === cols && value.rows === rows,
    );
    if (scenario === undefined || checkpoint === undefined || renderViewport === undefined) {
      throw new Error('Missing first-brief checkpoint or viewport');
    }
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
    try {
      const frame = stripTerminalControls(await handle.waitForCheckpoint(), {
        preserveLineBreaks: true,
      });
      const rail = frame.split('\n')[0] ?? '';
      expect(frame).toContain('T001');
      expect(frame).toContain('0/3 briefs passed');
      expect(rail).toContain(`${glyph('stageDone')} Build`);
      if (cols <= 60) {
        expect(rail.split(glyph('stageDone'))).toHaveLength(2);
        expect(rail).not.toContain('Plan');
      } else {
        expect(rail).toContain(`${glyph('stageDone')} Plan`);
        expect(rail).toContain('Review');
      }
    } finally {
      await handle.unmount();
    }
  });

  it.each([
    [60, 18],
    [80, 24],
    [160, 45],
  ])('keeps the completed run on the rail the width paints at %ix%i', async (cols, rows) => {
    const scenario = findVisualScenario('workflow-complete-after-fix-tasks');
    const checkpoint = scenario?.checkpoints[0];
    const renderViewport = scenario?.viewports.find(
      (value) => value.cols === cols && value.rows === rows,
    );
    if (scenario === undefined || checkpoint === undefined || renderViewport === undefined) {
      throw new Error('Missing complete-after-fix-tasks checkpoint or viewport');
    }
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
    try {
      const frame = stripTerminalControls(await handle.waitForCheckpoint(), {
        preserveLineBreaks: true,
      });
      const rail = frame.split('\n')[0] ?? '';
      expect(frame).toContain(`${glyph('stageDone')} 4/4`);
      if (cols <= 60) {
        expect(rail).toContain(`${glyph('stageDone')} Review`);
        expect(rail.split(glyph('stageDone'))).toHaveLength(2);
      } else {
        expect(rail.split(glyph('stageDone'))).toHaveLength(4);
        for (const stage of ['Plan', 'Build', 'Review']) expect(rail).toContain(stage);
      }
      if (cols >= 160) expect(frame).toContain('Tasks 4/4');
    } finally {
      await handle.unmount();
    }
  });

  it.each(WIDE_VIEWPORTS)(
    'shows T006 running and T007 held back after a fix insertion at %s',
    async (viewport) => {
      const scenario = findVisualScenario('workflow-stop-sheet-fix-inserted');
      const checkpoint = scenario?.checkpoints[0];
      if (scenario === undefined || checkpoint === undefined)
        throw new Error('Missing inserted-fix scenario');
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripTerminalControls(await handle.waitForCheckpoint())
          .replaceAll('│', '')
          .replace(/\s+/g, ' ');
        expect(frame).toContain('finish T006 including checks and review; do not start T007');
        expect(lifecycleStore.get().status).toBe('running');
        expect(eventsStore.get().events[0]?.type).toBe('workflow_started');
        expect(
          eventsStore.get().events.filter((event) => event.type === 'workflow_started'),
        ).toHaveLength(1);
        expect(runViewStore.get().briefs.tasks.map((task) => task.id)).toEqual([
          'T001',
          'T002',
          'T003',
          'T004',
          'T006',
          'T007',
          'T005',
        ]);
        expect(selectRunningBrief(runViewStore.get().briefs, 'implementing')).toMatchObject({
          current: { id: 'T006' },
          next: { id: 'T007' },
        });
        expect(selectTaskListView(runViewStore.get().briefs)).toMatchObject({
          passed: 4,
          total: 7,
          unannounced: 0,
        });
        if (viewport.cols > 120) {
          expect(frame).toContain('Implement and test overdue book lookup');
          expect(frame).toContain('T007 Test overdue report boundari…');
          expect(frame).toContain('T005 Wire the library dashboard');
          expect(frame.indexOf('T007 Test overdue report boundari…')).toBeLessThan(
            frame.indexOf('T005 Wire the library dashboard'),
          );
        }
      } finally {
        await handle.unmount();
      }
    },
  );
  it('keeps the Build rail active while the pause menu names the running brief', async () => {
    const scenario = findVisualScenario('workflow-stop-menu-pause');
    const selectedViewport = scenario?.viewports.find((value) => value.cols === 160);
    const checkpoint = scenario?.checkpoints[0];
    if (scenario === undefined || selectedViewport === undefined || checkpoint === undefined)
      throw new Error('Missing pause menu scenario');
    const handle = await mountGalleryScenario({ scenario, viewport: selectedViewport, checkpoint });
    try {
      const frame = stripTerminalControls(await handle.waitForCheckpoint());
      expect(frame).toContain('● Build');
      expect(frame).toContain('finish T002');
      expect(frame).toContain('Tasks 1/3');
      expect(frame).toContain('● T001');
      expect(lifecycleStore.get().status).toBe('running');
    } finally {
      await handle.unmount();
    }
  });

  it.each([
    'workflow-stop-sheet',
    'workflow-stop-menu-parked',
    'workflow-stop-menu-quit-hint',
    'workflow-stop-menu-failed',
    'workflow-quit-hint',
    'workflow-stop-sheet-after-continue',
  ])('seeds T001 passing before T002 starts in %s', async (id) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const selectedViewport = scenario?.viewports[0];
    if (!scenario || !checkpoint || !selectedViewport) throw new Error(`Missing scenario ${id}`);
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: selectedViewport });
    try {
      await handle.waitForCheckpoint();
      expect(selectTaskListView(runViewStore.get().briefs)).toMatchObject({ passed: 1, total: 3 });
      const events = eventsStore.get().events;
      const completedIndex = events.findIndex(
        (event) => event.type === 'task_completed' && event.taskId === 'T001',
      );
      const startedIndex = events.findIndex(
        (event) => event.type === 'task_started' && event.taskId === 'T002',
      );
      expect(completedIndex).toBeGreaterThan(0);
      expect(completedIndex).toBeLessThan(startedIndex);
    } finally {
      await handle.unmount();
    }
  });

  it.each(REQUIRED_VIEWPORTS)(
    'promises no changes at the halt once a git change put back every file at $cols x $rows',
    async (viewport) => {
      const scenario = findVisualScenario('workflow-stop-sheet-after-revert');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing stop sheet after revert scenario');
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripTerminalControls(await handle.waitForCheckpoint())
          .replaceAll('│', '')
          .replace(/\s+/g, ' ');
        // The halt row scrolls out of a 60x18 transcript, so it is read from the whole transcript,
        // with its Error heading: without that row, a Recovery card shows the same headline.
        const transcript = workflowTranscriptText().replaceAll('│', '').replace(/\s+/g, ' ');
        expect(runViewStore.get().briefKept).toBe(0);
        expect(transcript).toContain('Error Repository changed under T001 · tag v2.0.0');
        expect(frame).toContain('○ Choose how to continue');
        expect(recoveryNoticeStore.get().open).toBe(true);
        expect(frame).toContain('Stop now · stop execution; keep the run open');
        expect(frame).toContain('End run · stop execution; close this run');
        expect(frame).not.toContain('finish T001');
        expect(frame).not.toContain('keep partial changes');
        expect(frame).not.toContain('keep changes');
        expect(frame).not.toContain('Changes stay');
      } finally {
        await handle.unmount();
      }
    },
  );

  it.each(REQUIRED_VIEWPORTS)(
    'promises no changes at the halt once a denial took back every write at $cols x $rows',
    async (viewport) => {
      const scenario = findVisualScenario('workflow-stop-sheet-after-denial');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing stop sheet after denial scenario');
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripTerminalControls(await handle.waitForCheckpoint())
          .replaceAll('│', '')
          .replace(/\s+/g, ' ');
        expect(runViewStore.get().briefKept).toBe(0);
        expect(frame).toContain('Recovery Approval denied on T001');
        expect(frame).toContain('○ Choose how to continue');
        expect(recoveryNoticeStore.get().open).toBe(true);
        expect(frame).toContain('Stop now · stop execution; keep the run open');
        expect(frame).toContain('End run · stop execution; close this run');
        expect(frame).not.toContain('finish T001');
        expect(frame).not.toContain('keep partial changes');
        expect(frame).not.toContain('keep changes');
        expect(frame).not.toContain('Changes stay');
      } finally {
        await handle.unmount();
      }
    },
  );

  it.each(REQUIRED_VIEWPORTS)(
    'keeps the separator dot where a user message wraps at $cols x $rows',
    async (viewport) => {
      const scenario = findVisualScenario('workflow-recovery-review-fix-again');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing review fix again scenario');
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripTerminalControls(await handle.waitForCheckpoint())
          .replaceAll('│', '')
          .replace(/\s+/g, ' ');
        expect(frame).toContain(
          'Keep the cache key stable across restarts and deploys · F2 is right.',
        );
      } finally {
        await handle.unmount();
      }
    },
  );

  it.each(REQUIRED_VIEWPORTS)(
    'keeps plan and reviewer check rows after a ready verdict at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-continuous-transcript-ready');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing ready transcript checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = await ui.waitForCheckpoint();
        expect(frame).toContain('Apply');
        ui.stdin.write('\t');
        await flushEffects();
        const markers = [
          '● Plan',
          '● T001',
          '● T002',
          '● Final review passed',
          'Plan check K1',
          'Plan check K2',
          'Reviewer check V1',
        ];
        const history = await scrollTranscript(ui, markers);
        for (const marker of markers) expect(history).toContain(marker);
        expect(history.indexOf('● Final review passed')).toBeGreaterThan(
          history.indexOf('Reviewer check V1'),
        );
        expect(history).toContain('npm test · passed');
        expect(eventsStore.get().events.at(-1)?.type).toBe('replay_complete');
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each(REQUIRED_VIEWPORTS)(
    'keeps file bundle content plain at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-implementation-extracted-code');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing extracted-code checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        expect(frame).toContain('Pending 2');
        if (renderViewport.cols === 60 && renderViewport.rows === 18) {
          expect(frame).toContain('Pending 2 · +1 more');
        } else {
          expect(frame).toContain('T903 Capture the bounded fixture frame');
        }
        const markers = ['file-bundle-v1', '__init__(*args)', '<!-- keep -->', '`code`'];
        const history = await scrollTranscript(ui, markers);
        for (const marker of markers)
          expect(history.replace(/\s/g, '')).toContain(marker.replace(/\s/g, ''));
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each([
    ['workflow-implementation-narration', 'src/registry.ts'],
    ['workflow-implementation-adjacent-narration', 'src/fixture.ts'],
    ['workflow-implementation-fenced-handback', 'src/row.ts'],
  ])('renders marked implementer markdown in %s', async (id, label) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error(`Missing narration checkpoint ${id}`);
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      await ui.waitForCheckpoint();
      const markers = [label];
      if (id.endsWith('adjacent-narration')) markers.push('I run the two brief checks now.');
      if (id.endsWith('fenced-handback')) markers.push('Report  done');
      const history = await scrollTranscript(ui, markers);
      expect(history).toContain(label);
      expect(history).not.toContain('](file:');
      expect(history).not.toContain('`fixture`');
      if (id.endsWith('adjacent-narration')) {
        const messages = eventsStore.get().events.filter((event) => event.type === 'planner_text');
        expect(messages).toHaveLength(3);
        expect(messages[1]).toMatchObject({
          messageStart: true,
          text: 'The gallery has an uncommitted change.',
        });
        expect(history).toContain('I run the two brief checks now.');
      }
      if (id.endsWith('fenced-handback')) {
        expect(history).toContain('Report  done');
        expect(history).not.toContain('filesChanged');
      }
    } finally {
      await ui.unmount();
    }
  });

  it('keeps earlier brief boundary rows when the next brief starts', async () => {
    const scenario = findVisualScenario('workflow-completed-orphan-rows');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing orphan-row checkpoint');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      await ui.waitForCheckpoint();
      const markers = ['● T901', 'could not be read', 'also changed', '◉ T902'];
      const history = await scrollTranscript(ui, markers);
      for (const marker of markers) expect(history).toContain(marker);
    } finally {
      await ui.unmount();
    }
  });

  it('records the balance refusal, automatic switch, and restarted task with the fallback seat', async () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-seat-switched-balance'));
    if (projection === undefined) throw new Error('Missing balance-switch scenario');
    for (const event of projection.events)
      expect(EngineEventSchema.safeParse(event).success).toBe(true);
    const switchIndex = projection.events.findIndex((event) => event.type === 'seat_switched');
    expect(projection.events[switchIndex]).toMatchObject({
      seat: 'build',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      cause: 'runner-usage-limit',
      accountCause: 'balance',
      headline: 'Balance spent on deepseek (OpenCode CLI)',
      auto: true,
    });
    expect(projection.config?.implementer).toMatchObject({
      tool: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      variant: 'high',
      fallback: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
    });
    expect(
      projection.events
        .filter((event) => event.type === 'task_started')
        .map((event) => event.lineageAttempt),
    ).toEqual([1, 1]);
    expect(projection.events.slice(switchIndex + 1)).toContainEqual(
      expect.objectContaining({
        type: 'task_started',
        tool: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
        axes: ['high'],
        backendKind: 'cli',
        implementerProfile: 'default',
      }),
    );
    expect(projection.events.filter((event) => event.type === 'warning')).toEqual([]);
    for (const event of projection.events.filter((event) => event.type === 'task_started')) {
      expect(event.files).toEqual(['src/text.js', 'test/text.test.js']);
    }
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(frame).toContain('BUILD OpenCode CLI · DeepSeek V4.1 Flash · via deepseek');
    expect(frame).toContain('→ OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go');
    expect(frame).toContain('high');
    expect(frame).toContain('automatic fallback');
    expect(frame).not.toContain('BUILD seat changed');
    expect(frame).not.toContain('Add credit');
    expect(frame).not.toContain('Change BUILD tool');
    expect(frame).not.toContain('BUILD failed');
    expect(frame).toContain('Balance spent on deepseek (OpenCode CLI)');
    expect(frame).not.toContain('usage limit');
    expect(frame).not.toContain('worker ');
    expect(frame).not.toContain('Workspace kept');
  });

  it('records the failed call, recovery prompt, and restarted fallback call in order', async () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-seat-switched-balance'));
    if (projection === undefined) throw new Error('Missing balance-switch scenario');
    const events = projection.events;
    expect(events.map((event) => event.type)).toEqual([
      'workflow_started',
      'task_started',
      'runner_call_started',
      'runner_call_warning',
      'runner_call_activity',
      'runner_call_error',
      'runner_call_activity',
      'implementer_generate_failed',
      'error',
      'recovery_prompted',
      'recovery_action_selected',
      'seat_switched',
      'recovery_resolved',
      'task_started',
      'runner_call_started',
      'runner_call_tool_use',
      'runner_call_activity',
      'planner_text',
      'runner_call_completed',
      'implementer_generate_done',
      'task_completed',
    ]);
    const calls = events.filter((event) => event.type.startsWith('runner_call_'));
    expect(calls.slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () =>
        expect.objectContaining({
          callId: 'visual-opencode-balance-failed',
          role: 'implementer',
          backendKind: 'cli',
          runnerName: 'opencode',
          model: 'deepseek/deepseek-flash',
          axes: [],
          attempt: 0,
          taskId: 'T901',
          usageBoundary: 'aggregate',
        }),
      ),
    );
    expect(calls.slice(5)).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({
          callId: 'visual-opencode-balance-restarted',
          role: 'implementer',
          backendKind: 'cli',
          runnerName: 'opencode',
          model: 'opencode-go/deepseek-v4.1-flash',
          axes: ['high'],
          attempt: 0,
          taskId: 'T901',
          usageBoundary: 'aggregate',
        }),
      ),
    );
    expect(calls.at(-3)).toMatchObject({
      type: 'runner_call_tool_use',
      stage: 'delta',
      name: 'read',
      inputDelta: JSON.stringify({ path: 'src/text.js' }),
    });
    expect(calls.at(-2)).toMatchObject({
      type: 'runner_call_activity',
      kind: 'read',
      label: 'reading src/text.js',
      target: 'src/text.js',
    });
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(calls.at(-1)).toMatchObject({ type: 'runner_call_completed', status: 'completed' });
    expect(frame).toContain('1/1 briefs passed');
    expect(frame).not.toContain('working on T901');
    expect(frame).toContain(
      'BUILD activity 1 update [DeepSeek V4.1 Flash · via opencode-go · high]',
    );
    expect(frame).toContain('Read src/text.js');
    expect(frame).not.toContain('attempt 2');
  });

  it('shows the fallback effort on the BUILD sidebar after a balance switch', async () => {
    const scenario = findVisualScenario('workflow-seat-switched-balance');
    const checkpoint = scenario?.checkpoints[0];
    const wide = scenario?.viewports.find((size) => size.cols === 160);
    if (!scenario || !checkpoint || !wide) throw new Error('Missing wide balance-switch scenario');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: wide });
    try {
      const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
        preserveLineBreaks: true,
      });
      const sidebar = frame
        .split('\n')
        .map((row) => row.trimStart())
        .filter((row) => row.startsWith('│'))
        .map((row) => row.slice(0, row.indexOf('│', 1) + 1))
        .join(' ');
      expect(sidebar).toContain('DeepSeek V4.1 Flash');
      expect(sidebar).toContain('via opencode-go · high');
      expect(sidebar).not.toContain('deepseek/deepseek-flash');
      expect(frame).toContain('Balance spent on deepseek (OpenCode CLI)');
      expect(frame).not.toContain('worker ');
      expect(sidebar).not.toMatch(/deepseek[^│]*· auto\b/);
      expect(frame).not.toMatch(/deepseek[^\n]*· auto\b/);
    } finally {
      await ui.unmount();
    }
  });

  it.each(WIDE_VIEWPORTS)(
    'keeps the balance switch reachable at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-seat-switched-balance');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing balance-switch scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint());
        expect(frame).not.toContain('worker ');
        expect(frame).not.toContain('Workspace kept');
        const markers = [
          'Recovery  Balance spent on deepseek (OpenCode CLI)',
          'BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
          '→ OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go',
          'automatic fallback',
        ];
        const reached = await scrollTranscript(ui, markers);
        for (const marker of markers) expect(reached).toContain(marker);
        for (const stale of [
          'Add credit',
          'Change BUILD tool',
          'BUILD failed',
          'BUILD seat changed',
        ]) {
          expect(reached).not.toContain(stale);
        }
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each(WIDE_VIEWPORTS)(
    'shows the shell resolved model when the sidebar is visible at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-implementation-shell-seat-resolved');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing shell resolved model scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        expect(frame).toContain('Custom Shell');
        expect(tokensStore.get().resolvedModels.build).toMatchObject({
          backendKind: 'shell',
          resolvedModel: 'claude-sonnet-5-5',
        });
        if (getWorkflowSidebarWidth({ cols: renderViewport.cols, sidebarVisible: true }) > 0) {
          const lines = frame.split('\n');
          const buildIndex = lines.findIndex((line) => line.includes('BUILD   Custom Shell'));
          expect(buildIndex).toBeGreaterThanOrEqual(0);
          expect(lines[buildIndex]).not.toContain('claude-sonnet-5-5');
          expect(lines[buildIndex + 1]).toContain('claude-sonnet-5-5');
        }
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each(['default', 'typed'] as const)(
    'renders the %s consult answer beneath its question in the brief section',
    async (kind) => {
      const scenario = findVisualScenario(`workflow-consult-answer-${kind}`);
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing consult scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint());
        const answer = kind === 'default' ? 'memory' : 'redis';
        expect(
          ui
            .frameHistory()
            .some((frame) => stripTerminalControls(frame).includes('Question 1 of 1')),
        ).toBe(true);
        expect(frame.indexOf(`You → ${answer}`)).toBeGreaterThan(frame.indexOf('Which store?'));
        expect(frame.indexOf('Which store?')).toBeGreaterThan(frame.indexOf('T901'));
        expect(eventsStore.get().events.filter((event) => event.type === 'user_message')).toEqual([
          expect.objectContaining({
            text: `1. Which store?\n${answer}`,
            qa: [{ question: 'Which store?', answer }],
          }),
        ]);
        expect(frame).toContain(
          'PLAN · Claude Code CLI · Claude Sonnet 4 · answering the consult on T901',
        );
        expect(frame).toMatch(/last event \d+s ago/);
        expect(frame).not.toContain('no update yet');
        expect(operationsStore.get().byCallId.get('visual-consult-call-001')).toMatchObject({
          status: 'completed',
          role: 'planner',
          taskId: 'T901',
        });
      } finally {
        await ui.unmount();
      }
    },
  );

  it('no gallery fixture seeds final-review planner prose', () => {
    for (const projection of workflowFixtureProjections.values()) {
      expect(
        projection.events.filter(
          (event) =>
            event.type === 'planner_text' &&
            event.phase === 'final-review' &&
            // Apply announces the integration re-review in its phase (apply/run.ts).
            !event.text.startsWith('Your checkout changed '),
        ),
        projection.scenarioId,
      ).toHaveLength(0);
    }
  });

  it('shows three completed briefs before the mixed base review checks', async () => {
    const scenario = findVisualScenario('workflow-review-base-mixed');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing mixed base review scenario');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      expect(stripAnsiStyles(await ui.waitForCheckpoint())).toContain('3/3 briefs passed');
      const frame = stripAnsiStyles(
        await scrollTranscript(ui, ['● T001', '● T002', '● T003', 'Reviewer check V1']),
      );
      const review = frame.indexOf('Reviewer check V1');
      for (const id of ['T001', 'T002', 'T003']) {
        const brief = frame.indexOf(`● ${id}`);
        expect(brief).toBeGreaterThanOrEqual(0);
        expect(brief).toBeLessThan(review);
      }
    } finally {
      await ui.unmount();
    }
  });

  it('shows the timeout cause and duration on the fix-check row', async () => {
    const scenario = findVisualScenario('workflow-check-timed-out');
    const checkpoint = scenario?.checkpoints[0];
    const projection = workflowFixtureProjections.get(scenarioId('workflow-check-timed-out'));
    if (scenario === undefined || checkpoint === undefined || projection === undefined) {
      throw new Error('Missing timed-out fix check scenario');
    }
    const check = projection.events.find((event) => event.type === 'full_suite');
    expect(check).toMatchObject({
      id: 'V1',
      moment: 'brief',
      status: 'done',
      passed: false,
      timedOut: true,
      duration: 3_600_417,
      command: 'npm run release-check',
    });
    expect(projection.sidebarVisible).toBe(true);
    const renderViewport = scenario.viewports.find((value) => value.cols === 120);
    if (renderViewport === undefined) {
      throw new Error('Missing timed-out fix check viewport');
    }
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
    try {
      await ui.waitForCheckpoint();
      const rows = workflowTranscriptText()
        .split('\n')
        .map((row) => row.replaceAll('\u00a0', ' ').trim());
      expect(
        rows.filter((row) => row === 'Fix check V1 · npm run release-check · timed out · 1h 0m 0s'),
      ).toHaveLength(1);
    } finally {
      await ui.unmount();
    }
  });

  it.each([140, 120])(
    'keeps the long base-check clock on its verdict row at %i columns',
    async (cols) => {
      const scenario = findVisualScenario('workflow-base-rerun-long-command');
      const checkpoint = scenario?.checkpoints[0];
      const projection = workflowFixtureProjections.get(
        scenarioId('workflow-base-rerun-long-command'),
      );
      if (scenario === undefined || checkpoint === undefined || projection === undefined) {
        throw new Error('Missing long base re-run scenario');
      }
      const base = projection.events.find(
        (event) => event.type === 'full_suite' && event.moment === 'base',
      );
      expect(base).toMatchObject({
        id: 'V5',
        moment: 'base',
        status: 'done',
        passed: true,
        duration: 94_108,
        command:
          'npx --no-install vitest run --project integration src/features/workflow/run-history.integration.test.ts src/features/workflow/conversation-rows/run-transcript.integration.test.ts',
      });
      expect(projection.sidebarVisible).toBe(true);
      expect(projection.events.filter((event) => event.type === 'full_suite')).toHaveLength(1);
      const renderViewport = scenario.viewports.find((value) => value.cols === cols);
      if (renderViewport === undefined) {
        throw new Error(`Missing long base re-run viewport at ${cols} columns`);
      }
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        await ui.waitForCheckpoint();
        const rows = workflowTranscriptText()
          .split('\n')
          .map((row) => row.replaceAll('\u00a0', ' '));
        const matching = rows.filter(
          (row) =>
            row.includes('Base re-run V5') && row.endsWith('passes at the run base · 1m 34s'),
        );
        expect(matching).toHaveLength(1);
      } finally {
        await ui.unmount();
      }
    },
  );

  it('replays the completed briefs and the mid-step stop at T003 in the paused run', async () => {
    const scenario = findVisualScenario('workflow-at-rest-paused');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing paused run scenario');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      const live = stripTerminalControls(await ui.waitForCheckpoint());
      expect(live).toContain('│ Stopped at T003');
      expect(live).not.toContain('no events yet');
      const markers = ['● T001', '● T002', '× T003 Add signup route tests'];
      const history = await scrollTranscript(ui, markers);
      for (const marker of markers) expect(history).toContain(marker);
      expect(history).not.toContain('working on');
    } finally {
      await ui.unmount();
    }
  });

  it.each(REQUIRED_VIEWPORTS)(
    'keeps the settled review and fix brief reachable by scrolling at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-review-fix-cycles');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing fix-cycle scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const live = stripAnsiStyles(await ui.waitForCheckpoint());
        expect(live).toContain('Review · Reviewer check V2');
        const markers = ['● Plan', 'Final review failed', 'fixes T904', '● T904'];
        const history = await scrollTranscript(ui, markers);
        for (const marker of markers) expect(history).toContain(marker);
      } finally {
        await ui.unmount();
      }
    },
  );
  it('shows distinct tool-call details in the expanded activity block', async () => {
    const projection = workflowFixtureProjections.get(
      scenarioId('workflow-implementation-tool-details'),
    );
    if (projection === undefined) throw new Error('Missing tool-details scenario');
    const activities = projection.events.filter((event) => event.type === 'runner_call_activity');
    expect(activities).toHaveLength(6);
    expect(activities.map((event) => event.stage)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'updated',
    ]);
    expect(activities.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(activities.map((event) => event.activityId.split(':').at(-1))).toEqual([
      'visual-tool-read-range',
      'visual-tool-read-open',
      'visual-tool-read-window',
      'visual-tool-edit-lines',
      'visual-tool-command-description',
      'visual-tool-script',
    ]);
    expect(
      activities.map((event) => ({
        kind: event.kind,
        target: event.target,
        label: event.label,
        ...(event.description !== undefined && { description: event.description }),
        ...(event.moreLines !== undefined && { moreLines: event.moreLines }),
      })),
    ).toEqual([
      {
        kind: 'read',
        target: 'src/loans/renewals.ts :120-159',
        label: 'reading src/loans/renewals.ts :120-159',
      },
      {
        kind: 'read',
        target: 'biome.json :70-end',
        label: 'reading biome.json :70-end',
      },
      {
        kind: 'read',
        target: 'biome.json :39-58',
        label: 'reading biome.json :39-58',
      },
      {
        kind: 'write',
        target: `src/loans/renewals.ts${SOFT_SEP}12 lines`,
        label: `editing src/loans/renewals.ts${SOFT_SEP}12 lines`,
      },
      {
        kind: 'command',
        target: 'grep -c action src && git diff --name-only',
        label: 'running grep -c action src && git diff --name-only',
        description: 'Count the action flags and show the changed files',
      },
      {
        kind: 'command',
        target: 'cat src/loans/renewals.ts',
        label: [
          'running /bin/zsh -lc "cat src/loans/renewals.ts',
          "sed -n '960,1048p' src/loans/overdue.ts",
          'cat package.json"',
        ].join(' '),
        moreLines: 2,
      },
    ]);
    for (const activity of activities.slice(0, 4)) {
      expect(activity).not.toHaveProperty('description');
      expect(activity).not.toHaveProperty('moreLines');
    }
    const described = activities[4];
    const script = activities[5];
    if (described === undefined || script === undefined) {
      throw new Error('Missing tool detail activity');
    }
    expect(described).not.toHaveProperty('moreLines');
    expect(script).not.toHaveProperty('description');

    const scenario = findVisualScenario(projection.scenarioId);
    const checkpoint = scenario?.checkpoints[0];
    if (scenario === undefined || checkpoint === undefined) {
      throw new Error('Missing tool-details checkpoint');
    }
    for (const renderViewport of REQUIRED_VIEWPORTS) {
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripAnsiStyles(await ui.waitForCheckpoint());
        const lines = workflowTranscriptText().split('\n');
        const header = lines.findIndex(
          (line) => line.includes('BUILD activity') && line.includes('6 updates'),
        );
        expect(header).toBeGreaterThanOrEqual(0);
        expect(lines[header + 1]).toContain('collapse · ctrl+a');
        const details = lines.slice(header + 2, header + 8);
        expect(details[0]).toContain('src/loans/renewals.ts :120-159');
        expect(details[1]).toContain('biome.json :70-end');
        expect(details[2]).toContain('biome.json :39-58');
        expect(details[3]).toContain(`src/loans/renewals.ts${SOFT_SEP}12 lines`);
        expect(details[4]).toContain('Count the action flags');
        if (renderViewport.cols > 60) {
          expect(details[4]).toContain('Count the action flags and show the changed files');
        }
        expect(details[5]).toContain(`cat src/loans/renewals.ts${SOFT_SEP}+2 lines`);
        expect(lines[header + 8] ?? '').toBe('');
        const frameLines = frame.split('\n');
        const disclosureIndex = frameLines.findIndex((line) => line.includes('collapse · ctrl+a'));
        const headerIndex = frameLines.findIndex((line) => line.includes('BUILD activity'));
        const firstRead = frameLines.find((line) => line.includes('renewals.ts :120-159'));
        const newest = frameLines.find(
          (line) => line.includes(glyph('treeLast')) && line.includes('+2 lines'),
        );
        expect(disclosureIndex).toBeGreaterThanOrEqual(0);
        expect(frameLines[disclosureIndex]).toContain(glyph('treeBranch'));
        if (headerIndex >= 0) expect(disclosureIndex).toBe(headerIndex + 1);
        expect(firstRead).toContain(glyph('treeBranch'));
        expect(newest).toBeDefined();
      } finally {
        await ui.unmount();
      }
    }
  });

  it('names the folder of each search in the activity block', () => {
    const projection = workflowFixtureProjections.get(
      scenarioId('workflow-implementation-search-folders'),
    );
    if (projection === undefined) throw new Error('Missing search-folders scenario');
    const activities = projection.events.filter((event) => event.type === 'runner_call_activity');
    expect(activities.map((event) => event.target)).toEqual([
      `renewalWindow${SOFT_SEP}src/loans${SOFT_SEP}*.ts`,
      `renewalWindow${SOFT_SEP}src/loans/rules`,
      'renewalWindow',
    ]);
  });

  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    teardownVisualFixture();
  });

  it.each([...workflowFixtureProjections.values()])(
    'renders $scenarioId checkpoint through the production App without starting live work',
    async (projection) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await renderProjection(projection);
      expect(fetch).not.toHaveBeenCalled();
    },
    60_000,
  );

  it('initializes the requested viewport and resets prompt, review, event, and stream state', async () => {
    const review = workflowFixtureProjections.get(scenarioId('workflow-review'));
    const question = workflowFixtureProjections.get(scenarioId('workflow-question'));
    const implementation = workflowFixtureProjections.get(scenarioId('workflow-implementation'));
    const idle = workflowFixtureProjections.get(scenarioId('workflow-idle'));
    if (!review || !question || !implementation || !idle) {
      throw new Error('Missing required workflow projections');
    }

    const reviewSetup = await setupProjection(review);
    expect(approvalPromptStore.get().status).toBe('pending');
    expect(reviewStore.get().filePath).not.toBeNull();
    expect(questionPromptStore.get().hint).toBeNull();
    expect(controlsStore.get().inputMode).toBe('review');
    expect(getWorkflowFixturePromptRows(review, VIEWPORT.cols)).toBeGreaterThan(0);

    const implementationSetup = await setupProjection(implementation);
    expect(controlsStore.get().sidebarVisible).toBe(true);

    const questionSetup = await setupProjection(question);
    expect(approvalPromptStore.get().status).toBe('idle');
    expect(reviewStore.get().filePath).toBeNull();
    expect(questionPromptStore.get().hint).toBe(question.question?.prompt);
    expect(controlsStore.get().inputMode).toBe('question');

    const idleSetup = await setupProjection(idle);
    expect(configStore.get().config).not.toBeNull();
    expect(terminalSizeStore.get()).toMatchObject({ cols: 80, rows: 24, isSmall: true });
    expect(eventsStore.get().events).toEqual([]);
    expect(questionPromptStore.get().hint).toBeNull();
    expect(controlsStore.get().inputMode).toBe('normal');
    expect(controlsStore.get().sidebarVisible).toBe(false);
    expect(streamingOutputStore.get()).toMatchObject({ active: false, lines: [] });

    await reviewSetup.teardown();
    await implementationSetup.teardown();
    await questionSetup.teardown();
    await idleSetup.teardown();
  });

  it.each(WIDE_VIEWPORTS)(
    'keeps the current question and action hint inside $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-question');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing question gallery checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        expect(frame).toContain('Question 1 of 3');
        expect(frame).toContain('Which seat performs the per-slice review?');
        expect(frame).not.toContain('What should a');
        expect(frame).not.toContain('Where should sliced review live');
        expect(frame).toContain('tab');
        expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(renderViewport.rows);
      } finally {
        await ui.unmount();
      }
    },
  );

  it('shows the Apply refusal once and keeps its words in the composer', async () => {
    const reason = 'Cannot send words to Apply. Clear them.';
    const apply = await captureGalleryFrame('workflow-apply-recheck-words-refused', 80);
    expect(apply.feedback).toEqual({ message: reason, isError: false });
    expect(apply.frame.split(reason)).toHaveLength(2);
    expect(apply.frame).toContain('also fix the typo');
    expect(apply.frame).not.toContain('Warning');
    expect(startsWithText(apply.frame, reason)).toBe(true);
    expect(apply.events.filter((event) => event.type === 'warning')).toEqual([]);

    const recheck = await captureGalleryFrame('workflow-apply-recheck-review-none', 80);
    expect(recheck.frame).toContain('3/3 briefs passed');
    expect(recheck.frame).toContain('/ for a command…');
    expect(recheck.frame).not.toContain(reason);

    const usage = await captureGalleryFrame('workflow-plan-card-usage-refused');
    expect(usage.feedback).toEqual({
      message: '/end takes no argument. Usage: /end',
      isError: false,
    });
    expect(usage.frame.split('/end takes no argument. Usage: /end')).toHaveLength(2);
    expect(usage.frame).toContain('› /end now');
    expect(startsWithText(usage.frame, '/end takes no argument. Usage: /end')).toBe(true);

    const palette = await captureGalleryFrame('home-palette-prefill-refused');
    expect(palette.feedback).toEqual({
      message: 'Unknown seat: zzz. Valid: plan, build, review',
      isError: false,
    });
    expect(palette.frame.split('Unknown seat: zzz')).toHaveLength(2);
    expect(palette.frame).toContain('/he');
    expect(startsWithText(palette.frame, 'Unknown seat: zzz')).toBe(true);

    const draft = await captureGalleryFrame('workflow-draft-not-saved');
    expect(draft.feedback.isError).toBe(true);
    expect(startsWithText(draft.frame, `${glyph('statusFailed')} Draft not saved`)).toBe(true);

    const lock = await captureGalleryFrame('workflow-run-lock-not-released');
    expect(lock.feedback.isError).toBe(true);
    expect(
      startsWithText(lock.frame, `${glyph('statusFailed')} Could not release the run lock`),
    ).toBe(true);
  }, 60_000);

  it('shows the stop steer refusal neutrally and keeps its command in the composer', async () => {
    const reason = 'Finish stopping before steering.';
    const steer = await captureGalleryFrame('workflow-stop-steer-refused', 80);
    expect(steer.feedback).toEqual({ message: reason, isError: false });
    expect(steer.frame.split(reason)).toHaveLength(2);
    expect(steer.frame).toContain('/steer also fix the typo');
    expect(steer.frame).toContain('Finishing cleanup and saving');
    expect(steer.frame).not.toContain('Warning');
    expect(startsWithText(steer.frame, reason)).toBe(true);
    expect(steer.events.filter((event) => event.type === 'warning')).toEqual([]);

    const halt = await captureGalleryFrame('workflow-recovery-steer-refused');
    expect(halt.feedback).toEqual({
      message: 'This halt takes no typed correction. Choose an action.',
      isError: false,
    });
    expect(halt.frame).toContain('/steer use the old name');
    expect(startsWithText(halt.frame, 'This halt takes no typed correction')).toBe(true);

    const image = await captureGalleryFrame('workflow-command-image-refused');
    expect(image.feedback).toEqual({
      message: 'A command sends no image. Remove the command, then press ctrl+⏎.',
      isError: false,
    });
    expect(image.frame).toContain('/steer fix the layout [image #1]');
    expect(startsWithText(image.frame, 'A command sends no image.')).toBe(true);

    const stopping = await captureGalleryFrame('workflow-stopping');
    expect(stopping.frame).toContain('Finishing cleanup and saving');
    expect(stopping.frame).toContain('esc back after stop');
    expect(stopping.frame).not.toContain(reason);

    const sheet = await captureGalleryFrame('workflow-stop-sheet-recovery');
    expect(sheet.frame).toContain('Stop options');
    expect(sheet.frame).toContain('Stop now');
    expect(sheet.frame).toContain('End run');

    const failedStop = await captureGalleryFrame('workflow-stop-failed-over-draft');
    expect(failedStop.frame).toContain('Stop failed');
    expect(failedStop.frame).toContain('also fix the typo');

    const quit = await captureGalleryFrame('workflow-quit-hint');
    expect(quit.feedback).toEqual({ message: 'Press ctrl+c again to quit', isError: false });
    expect(startsWithText(quit.frame, 'Press ctrl+c again to quit')).toBe(true);

    const queued = await captureGalleryFrame('workflow-implementation-queued');
    expect(queued.frame.split('1 queued for BUILD on T003')).toHaveLength(2);
  }, 60_000);

  it('shows the short None row in the completed wide-crew checkpoint', async () => {
    const scenario = findVisualScenario('workflow-crew-wide-review-none');
    const checkpoint = scenario?.checkpoints.find(
      (candidate) => candidate.id === 'crew-wide-review-none-end',
    );
    const renderViewport = scenario?.viewports.find(
      (value) => value.cols === 120 && value.rows === 40,
    );
    if (scenario === undefined || checkpoint === undefined || renderViewport === undefined) {
      throw new Error('Missing completed wide-crew REVIEW None checkpoint');
    }
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
    try {
      const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
        preserveLineBreaks: true,
      });
      expect(frame.split('Review · none · no seat reviewed this run')).toHaveLength(2);
      expect(frame).not.toContain('Inspecting deterministic fixture contract');
    } finally {
      await ui.unmount();
    }
  });

  it('projects prompt rows from the same state rendered by the workflow fixture', async () => {
    const review = workflowFixtureProjections.get(scenarioId('workflow-review'));
    const question = workflowFixtureProjections.get(scenarioId('workflow-question'));
    const idle = workflowFixtureProjections.get(scenarioId('workflow-idle'));
    if (!review || !question || !idle) {
      throw new Error('Missing required prompt projections');
    }

    expect(getWorkflowFixturePromptRows(review, VIEWPORT.cols)).toBeGreaterThan(0);
    expect(getWorkflowFixturePromptRows(question, VIEWPORT.cols)).toBeGreaterThan(0);

    for (const projection of [review, question, idle]) {
      const lifecycle = await setupProjection(projection);
      const questionHint =
        controlsStore.get().inputMode === 'question' ? questionPromptStore.get().hint : null;
      expect(getWorkflowFixturePromptRows(projection, VIEWPORT.cols)).toBe(
        getWorkflowPromptRows({
          approvalState: approvalPromptStore.get(),
          questionHint,
          questions: questionPromptStore.get().questions,
          cols: VIEWPORT.cols,
        }),
      );
      await lifecycle.teardown();
    }
  });
});

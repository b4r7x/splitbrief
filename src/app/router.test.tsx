import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { SOFT_SEP } from '../core/separators.js';
import { CREW_SEAT_LABELS } from '../core/crew/identity.js';
import { PICKER_ROLE_SEAT_IDS } from '../core/runners/seat-roles.js';
import type { RecoveryIssue } from '../core/schemas/recovery/schemas.js';
import { ZERO_TOKEN_USAGE } from '../core/schemas/tokens.js';
import { crewCommands } from '../core/runtime/commands/defs/crew.js';
import { viewCommands } from '../core/runtime/commands/defs/view.js';
import { configStore } from '../stores/project/config.js';
import { routerStore } from '../stores/navigation/router.js';
import { composerDraftStore } from '../stores/ui/composer-draft.js';
import { composerLiveStore } from '../stores/ui/composer-live.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { recoveryNoticeStore } from '../stores/workflow/recovery-notice.js';
import { tokensStore } from '../stores/workflow/tokens.js';
import type { WorkflowScreenDeps } from '../features/workflow/hooks/workflow-screen/use-model.js';
import { Router } from './router.js';

const ESCAPE = '\u001b';
const DOWN_ARROW = '\u001b[B';

function renderRouter() {
  return renderFeature(
    <Router
      screen="home"
      overlayActive={overlayStore.get().active}
      commands={[]}
      onRuntime={() => {}}
    />,
  );
}

describe('Router overlays', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 100, rows: 40 });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders the reviewer picker for the reviewer-picker overlay', async () => {
    overlayStore.open('reviewer-picker');
    const ui = renderRouter();
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    expect(frame).toContain(
      `${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS.reviewer]}${SOFT_SEP}tool, model, effort`,
    );
  });
});

/** The run the usage overlay opens over: read back from disk, so nothing is running behind it. */
const REPLAYED_RUN = makeRunRecord({
  ref: {
    projectDir: join(process.env.XDG_STATE_HOME ?? tmpdir(), 'router-usage'),
    sessionId: '2026-09-14-usage',
  },
  feature: 'Route the usage details overlay',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
    resumeAt: { kind: 'planner', call: 'tasks' },
  },
});

const DRAFT = 'half a sentence the operator has not sent';

function WorkflowRoute({ deps }: { deps: WorkflowScreenDeps }) {
  const overlayActive = overlayStore.use((state) => state.active);
  return (
    <Router
      screen="workflow"
      overlayActive={overlayActive}
      commands={[]}
      onRuntime={() => {}}
      workflowDeps={deps}
    />
  );
}

describe('Router usage overlay', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    routerStore.init({ screen: 'workflow', run: REPLAYED_RUN, execution: { kind: 'at-rest' } });
    tokensStore.__testReset({
      tokenUsage: {
        ...ZERO_TOKEN_USAGE,
        plannerInput: 12_400,
        plannerOutput: 3_200,
        plannerCoverage: {
          input: 'reported',
          output: 'reported',
          cacheRead: 'missing',
          cacheCreate: 'missing',
          reasoning: 'missing',
        },
      },
    });
    conversationScrollStore.__testReset({ scrollOffset: 7, renderableCountAtScroll: 19 });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('opens and closes the usage details without spending the run, the draft or the scroll', async () => {
    const runWorkflowCalls: string[] = [];
    const deps: WorkflowScreenDeps = {
      runWorkflow: async () => {
        runWorkflowCalls.push('runWorkflow');
        throw new Error('the usage overlay must not start a run');
      },
    };
    const ui = renderFeature(<WorkflowRoute deps={deps} />, { cols: 120, rows: 40 });
    await tick(20);
    // The draft is typed into the live composer, which is where it lives: the draft store is the
    // one-shot channel that delivers it and clears itself.
    composerDraftStore.request(DRAFT);
    await tick(20);
    const before = { scroll: conversationScrollStore.get(), route: routerStore.get() };

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(DRAFT);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('Usage details');
    expect(composerLiveStore.get().empty).toBe(false);
    // A scroll of zero would make the closing assertion vacuous.
    expect(before.scroll.scrollOffset).toBe(7);

    overlayStore.open('usage-details');
    await tick(20);
    const open = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(open).toContain('Usage details');
    expect(open).toContain('12,400');
    expect(open).toContain('esc close');

    // The overlay owns the keyboard while it is up: a keystroke does not reach the draft under it.
    ui.stdin.write('!');
    await tick(20);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain(`${DRAFT}!`);

    ui.stdin.write(ESCAPE);
    await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
    await tick(20);
    const closed = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(closed).not.toContain('Usage details');
    expect(closed).toContain(DRAFT);
    expect(composerLiveStore.get().empty).toBe(false);
    expect(conversationScrollStore.get()).toEqual(before.scroll);
    expect(routerStore.get()).toBe(before.route);
    expect(runWorkflowCalls).toEqual([]);

    // Focus is back where it was: the next keystroke lands in the draft, at its end.
    ui.stdin.write('!');
    await tick(20);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${DRAFT}!`);
    ui.unmount();
  });

  it("reads the money off the run's own record and scrolls to the end of it", async () => {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        ...REPLAYED_RUN,
        summary: makeSummary({
          costBreakdown: {
            actualPlannerCost: 0.42,
            actualImplementerCost: 0,
            totalActualCost: 0.42,
            hasPricedUsage: true,
            providerRunMetadata: {
              'claude-code': {
                service: 'claude-code',
                offering: 'payg',
                normalizedEndpoint: 'cli://claude-code',
                billing: 'api-metered',
                asOf: '2026-01-01',
                billingAttribution: {
                  posture: 'api-metered',
                  basis: 'enforced-channel',
                  evidenceId: 'cli.claude-code.api-key',
                },
              },
            },
          },
        }),
      }),
      execution: { kind: 'at-rest' },
    });
    overlayStore.open('usage-details');

    // Wide enough for the whole record: the amount and its evidence are the run's own, not a
    // re-pricing of today's catalog.
    const wide = renderFeature(<WorkflowRoute deps={{}} />, { cols: 120, rows: 40 });
    await tick(20);
    const whole = stripAnsiStyles(wide.lastFrame() ?? '');
    wide.unmount();

    expect(whole).toContain('$0.42');
    expect(whole).toContain('metered · enforced channel');

    // Too short for it: every row is still reachable by scrolling, none is lost.
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const short = renderFeature(<WorkflowRoute deps={{}} />, { cols: 60, rows: 18 });
    await tick(20);
    const top = stripAnsiStyles(short.lastFrame() ?? '');

    expect(top).toContain('more');
    expect(top).not.toContain('enforced channel');

    for (let press = 0; press < 20; press += 1) {
      short.stdin.write(DOWN_ARROW);
      await tick(5);
    }
    const bottom = stripAnsiStyles(short.lastFrame() ?? '');
    short.unmount();

    expect(bottom).toContain('metered · enforced channel');
  });

  it('says a run with nothing recorded has nothing to show', async () => {
    tokensStore.__testReset({ tokenUsage: null });
    overlayStore.open('usage-details');

    const ui = renderFeature(<WorkflowRoute deps={{}} />, { cols: 120, rows: 40 });
    await tick(20);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    expect(frame).toContain('No usage recorded');
  });
});

/** The halt a run parks on when the review seat could not hold its packet, as T-105 persists it. */
const CONTEXT_HALT: RecoveryIssue = {
  id: 'rec_router_context',
  reason: 'review-failed',
  seat: 'review',
  phase: 'final-review',
  status: 'awaiting-user',
  files: [],
  affectedTaskIds: [],
  message: 'The review seat was not given the context this call needs.',
  details: ['Pick a review seat with a larger context in /crew review, then choose Try again.'],
  facts: {
    apiContextCode: 'insufficient-context',
    apiContextSeat: 'review',
    apiContextCause: 'input-budget',
    apiContextModel: 'qwen3-coder-30b',
    apiContextMissingSectionsJson: '[]',
    reviewFailureKind: 'insufficient-context',
    apiContextInputEstimate: 404_000,
    apiContextEstimationMargin: 4_000,
    apiContextRequiredOutputTokens: 4_096,
    apiContextRequiredTokens: 412_096,
    apiContextAvailableTokens: 32_768,
    apiContextOutputCap: 8_192,
  },
  availableActions: ['retry-same-worker', 'end-run'],
  recommendedAction: 'retry-same-worker',
  createdAt: '2026-09-14T00:00:00.000Z',
};

const HALTED_RUN = makeRunRecord({
  ...REPLAYED_RUN,
  status: {
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: CONTEXT_HALT } },
    resumeAt: { kind: 'review', cycle: 0 },
  },
});

/** The real command, with its one capability pointed at the real store. */
function runRuntimeCommand(name: string, args?: string): void {
  const ctx = makeCtx({ openOverlay: (overlay, focus) => overlayStore.open(overlay, focus) });
  const command = [...viewCommands(ctx), ...crewCommands(ctx)].find((def) => def.name === name);
  if (command === undefined) throw new Error(`no command ${name}`);
  if (command.kind === 'noarg') command.handler();
  else if (command.kind === 'arg') command.handler(args);
  else throw new Error(`${name} is neither a no-argument nor an argument command`);
}

describe('Router usage overlay over a halted run', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    routerStore.init({ screen: 'workflow', run: HALTED_RUN, execution: { kind: 'at-rest' } });
    tokensStore.__testReset({ tokenUsage: { ...ZERO_TOKEN_USAGE, reviewerInput: 2_100 } });
    conversationScrollStore.__testReset({ scrollOffset: 7, renderableCountAtScroll: 19 });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('shows the halt figures through /usage and gives the run, the draft and the halt back', async () => {
    const runWorkflowCalls: string[] = [];
    const deps: WorkflowScreenDeps = {
      runWorkflow: async () => {
        runWorkflowCalls.push('runWorkflow');
        throw new Error('reading the halt must not start a run');
      },
    };
    const ui = renderFeature(<WorkflowRoute deps={deps} />, { cols: 120, rows: 40 });
    await tick(20);
    composerDraftStore.request(DRAFT);
    await tick(20);
    const before = { scroll: conversationScrollStore.get(), route: routerStore.get() };

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(DRAFT);
    expect(before.scroll.scrollOffset).toBe(7);

    runRuntimeCommand('/usage');
    await tick(20);
    const open = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(overlayStore.get().active).toBe('usage-details');
    expect(open).toContain('Usage details');
    expect(open).toContain('REVIEW');
    expect(open).toContain('qwen3-coder-30b');
    expect(open).toContain('larger than the context window');
    expect(open).toContain('412,096 tokens · input 404,000 · margin 4,000 · output reserve 4,096');
    expect(open).toContain('32,768 tokens · output cap 8,192');

    // The overlay owns the keyboard while it is up.
    ui.stdin.write('!');
    await tick(20);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain(`${DRAFT}!`);

    ui.stdin.write(ESCAPE);
    await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
    await tick(20);
    const closed = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(closed).not.toContain('Usage details');
    expect(closed).toContain(DRAFT);
    expect(conversationScrollStore.get()).toEqual(before.scroll);
    expect(routerStore.get()).toBe(before.route);
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('the run left its screen');
    expect(route.run.status).toEqual(HALTED_RUN.status);
    expect(runWorkflowCalls).toEqual([]);
    ui.unmount();
  });

  it('reads a halt this session still holds, before the run has been written back', async () => {
    // The record is the run as it was last read from disk: not halted, because the halt was raised
    // after it. The panel this process is holding open is where the issue is, and the page reads it
    // there through the same decoder.
    routerStore.init({ screen: 'workflow', run: REPLAYED_RUN, execution: { kind: 'at-rest' } });
    recoveryNoticeStore.open({ seat: null, resetAt: null, issue: CONTEXT_HALT });

    const ui = renderFeature(<WorkflowRoute deps={{}} />, { cols: 120, rows: 40 });
    await tick(20);
    runRuntimeCommand('/usage');
    await tick(20);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('the run left its screen');
    expect(route.run.status.kind).toBe('open');
    expect(route.run.status).toEqual(REPLAYED_RUN.status);
    expect(frame).toContain('REVIEW');
    expect(frame).toContain('larger than the context window');
    expect(frame).toContain('412,096 tokens · input 404,000 · margin 4,000 · output reserve 4,096');
  });

  it('sends /crew to the seat that refused, and opens no run doing it', async () => {
    const runWorkflowCalls: string[] = [];
    const deps: WorkflowScreenDeps = {
      runWorkflow: async () => {
        runWorkflowCalls.push('runWorkflow');
        throw new Error('opening a seat picker must not start a run');
      },
    };
    const ui = renderFeature(<WorkflowRoute deps={deps} />, { cols: 120, rows: 40 });
    await tick(20);

    runRuntimeCommand('/crew', CONTEXT_HALT.seat);
    await tick(20);

    expect(overlayStore.get().active).toBe('reviewer-picker');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      `${CREW_SEAT_LABELS.review}${SOFT_SEP}tool, model, effort`,
    );
    expect(runWorkflowCalls).toEqual([]);
    ui.unmount();
  });
});

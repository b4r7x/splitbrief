import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { TieredApprovalRequest } from '../../core/approval/types.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from './prompt-grace.js';

const runWorkflow = vi.hoisted(() => vi.fn());

vi.mock('../../engine/orchestrator/run/workflow.js', () => ({
  runWorkflow,
  WORKFLOW_REWIND_ABORT_REASON: 'workflow-rewind',
}));

const { WorkflowScreen } = await import('./screen.js');
const { configStore } = await import('../../stores/project/config.js');
const { terminalSizeStore } = await import('../../stores/ui/terminal-size.js');
const { routerStore } = await import('../../stores/navigation/router.js');
const { lifecycleStore } = await import('../../stores/workflow/lifecycle.js');
const { planEditorStore } = await import('../../stores/workflow/plan-editor.js');
const { openApprovalPrompt } = await import('../../stores/approval-prompt/prompt.js');
const { openCostApprovalPrompt } = await import('../../stores/cost-approval/prompt.js');

const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

function readyReadiness(projectDir: string): ReadinessReport {
  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
  };
}

function stickyRequest(): TieredApprovalRequest {
  return {
    tier: 'sticky',
    actionClass: 'write_out_of_scope',
    actionDescription: 'write outside task scope',
    phase: 'implementing',
  };
}

function mountWorkflow(rows = 60) {
  const projectDir = '/tmp/diptych-workflow-screen-test';
  configStore.__testReset({ config: makeConfig(), projectDir });
  terminalSizeStore.__testReset({ cols: 120, rows, isSmall: false });
  routerStore.navigate({
    to: 'workflow',
    feature: 'screen test feature',
    readiness: readyReadiness(projectDir),
  });
  return renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
}

describe('WorkflowScreen key arbitration', () => {
  beforeEach(() => {
    resetAllStores();
    routerStore.navigate({ to: 'home' });
    runWorkflow.mockReset();
    // The engine never resolves so the screen stays on the live workflow surface for the
    // duration of the test; no real planner/implementer runs.
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
  });

  afterEach(() => {
    resetAllStores();
    routerStore.navigate({ to: 'home' });
  });

  it('a pending approval prompt owns the keystroke; the focused composer does not capture it', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openApprovalPrompt(stickyRequest());
    await tick(PAST_GRACE);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('Approve once');

    // A single 's' must produce exactly one semantic action: the prompt's session-approve.
    // If the composer were still focused it would also append 's' to the input box.
    ui.stdin.write('s');
    await expect(decision).resolves.toEqual({ decision: 'allow', scope: 'session' });
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    // The composer's input row never received the 's' (it stayed on the placeholder hint).
    expect(frame).not.toMatch(/>\s+s(\s|$)/m);

    ui.unmount();
  });

  it('keeps a pending approval prompt answerable on a terminal too short to render it', async () => {
    // rows=6 with the default 3-row composer leaves no middle budget, so the prompt clamps to
    // zero rows. The handler must still be registered or the prompt deadlocks unanswerably.
    const ui = mountWorkflow(6);
    await tick(20);

    const decision = openApprovalPrompt(stickyRequest());
    await tick(PAST_GRACE);
    await tick(20);

    ui.stdin.write('s');
    await expect(decision).resolves.toEqual({ decision: 'allow', scope: 'session' });

    ui.unmount();
  });

  it('ignores a keystroke buffered into the grace window, then honours it', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openApprovalPrompt(stickyRequest());
    await tick(20);

    // The 'x' arrives inside the grace window (a keystroke meant for the composer that was
    // in flight when the prompt opened). It must not deny the prompt.
    ui.stdin.write('x');
    await tick(20);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await tick(20);
    expect(settled).toBe(false);

    await tick(PAST_GRACE);
    ui.stdin.write('x');
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });

    ui.unmount();
  });

  it('a pending cost prompt owns y/n; the composer stays disabled', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openCostApprovalPrompt({
      estimatedTasks: 3,
      lowCost: 0.01,
      expectedCost: 0.02,
      highCost: 0.05,
      plannerTool: 'anthropic',
      implementerTool: 'anthropic',
      deterministic: {
        taskCount: 3,
        taskFitCounts: { fits: 3, tight: 0, overflow: 0, unknown: 0 },
        contextConfidenceCounts: {
          contextExplicit: 3,
          contextDetected: 0,
          contextKnownCatalog: 0,
          contextCachedProvider: 0,
          contextConservativeFallback: 0,
          profileUnavailable: 0,
        },
        priceConfidenceCounts: { priceKnown: 3, priceUnknown: 0, profileUnavailable: 0 },
        tasks: [],
        totals: {
          knownActualEstimate: 0.02,
          hypotheticalAllPlanner: 0.1,
          estimatedSavings: 0.08,
          unknownCostReason: [],
        },
      },
    });
    await tick(PAST_GRACE);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('Cost Approval Required');

    ui.stdin.write('n');
    await expect(decision).resolves.toBe(false);

    ui.unmount();
  });

  it('the composer captures a printable key while no rich editor is mounted', async () => {
    const ui = mountWorkflow();
    await tick(20);

    // Control: outside brief review the composer owns printable keystrokes.
    ui.stdin.write('j');
    await tick(20);

    expect(ui.lastFrame() ?? '').toMatch(/>\s+j(\s|$)/m);

    ui.unmount();
  });

  it('the focused composer does not capture the rich plan editor keymap during brief review', async () => {
    const ui = mountWorkflow();
    await tick(20);

    // The runner's resetWorkflow runs on mount; drive the rich brief-review surface afterwards.
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    planEditorStore.setRuntimeRichMode(true);
    await tick(20);

    // 'j' is a plain-printable plan-editor key (move cursor down). The composer must be
    // disabled while the rich editor is active so it never appends 'j' to the input box.
    ui.stdin.write('j');
    await tick(20);

    expect(ui.lastFrame() ?? '').not.toMatch(/>\s+j(\s|$)/m);

    ui.unmount();
  });
});

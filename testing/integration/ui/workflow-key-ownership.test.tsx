import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { CONFIRM_PHRASE, type TieredApprovalRequest } from '../../../src/core/approval/types.js';
import { CONFIRM_REASON_UNSTATED } from '../../../src/features/workflow/prompt-rows/approval.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { mountWorkflowScreen } from '#testing/helpers/workflow-screen.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };
let projectDir = '';

const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { lifecycleStore } = await import('../../../src/stores/workflow/lifecycle.js');
const { openApprovalPrompt } = await import('../../../src/stores/approval-prompt/prompt.js');

const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

const CONFIRMED = {
  decision: 'confirm',
  phrase: CONFIRM_PHRASE,
  reason: CONFIRM_REASON_UNSTATED,
} as const;

function confirmRequest(): TieredApprovalRequest {
  return {
    tier: 'confirm',
    actionClass: 'package_change',
    actionDescription: 'write package.json',
    phase: 'implementing',
  };
}

function mountWorkflow(rows = 60) {
  return mountWorkflowScreen({ deps: workflowDeps, projectDir, rows });
}

describe('WorkflowScreen key ownership', () => {
  beforeEach(() => {
    resetAllStores();
    routerStore.init({ screen: 'home' });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
    projectDir = createTempDir('workflow-screen-key-ownership');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetAllStores();
    routerStore.init({ screen: 'home' });
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('a pending approval prompt owns the keystroke; the focused composer does not capture it', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openApprovalPrompt(confirmRequest());
    await tick(PAST_GRACE);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('Confirm with a reason');

    // A single 'y' must produce exactly one semantic action: the prompt's confirm.
    // If the composer were still focused it would also append 'y' to the input box.
    await flushEffects();
    ui.stdin.write('y');
    await expect(decision).resolves.toEqual(CONFIRMED);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    // The composer's input row never received the 'y' (it stayed on the placeholder hint).
    expect(frame).not.toMatch(/>\s+y(\s|$)/m);

    ui.unmount();
  });
  it('keeps a pending approval prompt answerable on a terminal too short to render it', async () => {
    // rows=6 with the default 3-row composer leaves no middle budget, so the prompt clamps to
    // zero rows. The handler must still be registered or the prompt deadlocks unanswerably.
    const ui = mountWorkflow(6);
    await tick(20);

    const decision = openApprovalPrompt(confirmRequest());
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('y');
    await expect(decision).resolves.toEqual(CONFIRMED);

    ui.unmount();
  });

  it('ignores a keystroke buffered into the grace window, then honours it', async () => {
    const ui = mountWorkflow();
    await tick(20);

    const decision = openApprovalPrompt(confirmRequest());
    await tick(20);

    // The 'x' arrives inside the grace window (a keystroke meant for the composer that was
    // in flight when the prompt opened). It must not deny the prompt.
    await flushEffects();
    ui.stdin.write('x');
    await tick(20);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await tick(20);
    expect(settled).toBe(false);

    await tick(PAST_GRACE);
    await flushEffects();
    ui.stdin.write('x');
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });

    ui.unmount();
  });

  it('the composer captures a printable key while no review prompt is active', async () => {
    const ui = mountWorkflow();
    await tick(20);

    // Control: outside brief review the composer owns printable keystrokes.
    await flushEffects();
    ui.stdin.write('j');
    await tick(20);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} j`);

    ui.unmount();
  });
  it('the composer still captures printable keys during the reviewing-briefs phase', async () => {
    const ui = mountWorkflow();
    await tick(20);

    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    await flushEffects();

    ui.stdin.write('j');
    await tick(20);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} j`);

    ui.unmount();
  });
});

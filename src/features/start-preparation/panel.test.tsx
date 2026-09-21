import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  runnerAvailabilityCheck,
  type RunnerAvailabilityVerdict,
} from '../../core/readiness/checks/availability.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { StartPreparationPanel, type StartPreparationPanelProps } from './panel.js';

const ESC = '\x1b';
const DOWN = '\x1b[B';

function report(checks: ReadinessCheck[]): ReadinessReport {
  const blockers = checks.filter((check) => check.severity === 'blocker').length;
  const warnings = checks.filter((check) => check.severity === 'warning').length;
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir: '/project',
    status: blockers > 0 ? 'blocked' : 'ready-with-warnings',
    counts: { ok: 0, info: 0, warning: warnings, blocker: blockers },
    nextAction: {
      kind: blockers > 0 ? 'prepare-runner' : 'continue',
      label: blockers > 0 ? 'Prepare the runner' : 'Continue',
      reason: blockers > 0 ? 'Resolve the blockers.' : 'Tools are ready.',
    },
    sections: [{ id: 'runners', title: 'Runners', checks }],
    metadata: {},
  };
}

function check(id: string, severity: 'blocker' | 'warning'): ReadinessCheck {
  return { id, severity, summary: `${id} summary`, fix: `${id} fix` };
}

/** The real readiness copy for one seat's connection, so the panel is judged on what ships. */
function availability(
  verdict: RunnerAvailabilityVerdict,
  endpoint: string | null = 'http://localhost:11434',
): ReadinessCheck {
  return runnerAvailabilityCheck({
    fact: {
      slot: { role: 'planner' },
      provider: 'ollama',
      ...(endpoint !== null && { endpoint }),
      verdict,
    },
    label: 'Planner ollama',
    isDefaultImplementer: false,
  });
}

const TRUST_BOUNDARY: ReadinessCheck = {
  id: 'runners.planner.trust-boundary',
  severity: 'warning',
  summary: 'Planner claude-code can execute commands on this machine.',
  details: [
    'Spec/plan approval level: none.',
    'SPLITBRIEF approval gates review spec/plan documents and declared/promoted file writes; they do not sandbox shell commands or network access inside external runners.',
  ],
};

function renderPanel(
  props: Partial<StartPreparationPanelProps> & Pick<StartPreparationPanelProps, 'state'>,
  viewport = { cols: 120, rows: 40 },
) {
  terminalSizeStore.__testReset({ ...viewport, isSmall: viewport.cols < 120 });
  return renderFeature(
    <StartPreparationPanel
      onRetry={vi.fn()}
      onBack={vi.fn()}
      onOpenSettings={vi.fn()}
      {...props}
    />,
    viewport,
  );
}

describe('StartPreparationPanel', () => {
  beforeEach(() => resetAllStores());
  afterEach(() => resetAllStores());

  it('leads a failure with the error it raised, never with a blocker count of zero', async () => {
    const readiness = report([TRUST_BOUNDARY, check('repo.worktree.dirty', 'warning')]);
    expect(readiness.counts.blocker).toBe(0);
    const ui = renderPanel({
      state: {
        kind: 'failed',
        report: readiness,
        error: new Error('Session ownership could not be taken over: 20260804-a91f is held.'),
      },
    });

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Session ownership could not be taken over');
    // The warnings are still reported, and still under the error rather than in place of it.
    expect(frame.indexOf('Session ownership')).toBeLessThan(frame.indexOf('Warnings'));
    expect(frame.indexOf('Warnings')).toBeLessThan(frame.indexOf('can execute commands'));
    // The counter is not the diagnosis: no "0 blockers" anywhere, and an action is offered.
    expect(frame).not.toMatch(/\d+ blockers?/);
    expect(frame).toContain('Retry the check, or open settings to change the crew.');
    expect(frame).toContain('r retry');
    ui.unmount();
  });

  it('leads a blocked check with the blocking fact and that blocker’s own fix', async () => {
    const ui = renderPanel({
      state: {
        kind: 'blocked',
        report: report([availability({ state: 'no-models' }, null), TRUST_BOUNDARY]),
      },
    });

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Planner ollama answered but offers no models.');
    expect(frame).toContain('Install a model for ollama');
    expect(frame).not.toMatch(/\d+ blockers?/);
    expect(frame.indexOf('offers no models')).toBeLessThan(frame.indexOf('Warnings'));
    ui.unmount();
  });

  it('gives an unreachable local server its address, its start instruction and retry', async () => {
    const ui = renderPanel({
      state: {
        kind: 'blocked',
        report: report([
          availability({ state: 'unavailable', diagnostic: 'connection refused' }),
          TRUST_BOUNDARY,
        ]),
      },
    });

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('http://localhost:11434');
    expect(frame).toContain('Run `ollama serve`');
    expect(frame).toContain('r retry');
    // An offline server is not an auth problem: nothing here asks for a credential or a sign-in.
    expect(frame.toLowerCase()).not.toContain('sign in');
    expect(frame.toLowerCase()).not.toContain('credential');
    ui.unmount();
  });

  it('gives offline, unauthorized and a missing selected model their own precise action', async () => {
    const verdicts: RunnerAvailabilityVerdict[] = [
      { state: 'unavailable', diagnostic: 'connection refused' },
      { state: 'unauthorized', diagnostic: 'HTTP 401' },
      { state: 'missing-model', selectionId: 'qwen3-coder:30b' },
      { state: 'timeout', diagnostic: 'Request timed out' },
    ];
    const leads: string[] = [];
    for (const verdict of verdicts) {
      const ui = renderPanel({
        state: { kind: 'blocked', report: report([availability(verdict)]) },
      });
      await flushEffects();
      const frame = ui.lastFrame() ?? '';
      leads.push(frame);
      ui.unmount();
      resetAllStores();
    }
    const [offline, unauthorized, missingModel, timeout] = leads;

    expect(offline).toContain('is not reachable at http://localhost:11434');
    expect(offline).toContain('Run `ollama serve`');

    expect(unauthorized).toContain('rejected the configured credential');
    expect(unauthorized).toContain('Check the credential for ollama');
    expect(unauthorized).not.toContain('Run `ollama serve`');

    expect(missingModel).toContain('serve "qwen3-coder:30b"');
    expect(missingModel).toContain('Select a model ollama serves');
    expect(missingModel).not.toContain('is not reachable');

    expect(timeout).toContain('did not answer in time');
    expect(timeout).not.toContain('rejected the configured credential');
  });

  it('keeps check IDs and trust-boundary prose out of the summaries and under Details', async () => {
    // Tall enough that nothing is below the fold: the claim is about placement, not scrolling.
    const ui = renderPanel({
      state: {
        kind: 'blocked',
        report: report([
          availability({ state: 'unavailable', diagnostic: 'connection refused' }),
          TRUST_BOUNDARY,
        ]),
      },
    });

    await flushEffects();
    const rows = (ui.lastFrame() ?? '').split('\n');
    const summaryRow = rows.findIndex((row) => row.includes('is not reachable at'));
    const detailsRow = rows.findIndex((row) => row.includes('Details'));
    const idRow = rows.findIndex((row) => row.includes('runners.availability.planner'));
    const proseRow = rows.findIndex((row) => row.includes('do not sandbox shell'));

    expect(summaryRow).toBeGreaterThanOrEqual(0);
    expect(rows[summaryRow]).not.toContain('runners.availability.planner');
    expect(detailsRow).toBeGreaterThan(summaryRow);
    expect(idRow).toBeGreaterThan(detailsRow);
    expect(proseRow).toBeGreaterThan(detailsRow);
    expect(rows[idRow]).toContain('blocker');
    ui.unmount();
  });

  it('keeps the repair keys whole at 60x18 and scrolls the copy that does not fit', async () => {
    const readiness = report([
      availability({ state: 'unavailable', diagnostic: 'connection refused' }),
      TRUST_BOUNDARY,
      check('repo.worktree.dirty', 'warning'),
    ]);
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    const ui = renderPanel(
      { state: { kind: 'blocked', report: readiness }, onRetry, onBack, onOpenSettings },
      { cols: 60, rows: 18 },
    );

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    const hint = frame.split('\n').find((row) => row.includes('r retry')) ?? '';
    expect(hint).toContain('r retry');
    expect(hint).toContain('esc back');
    expect(hint).toContain('s settings');
    expect(hint).toContain('scroll');
    expect(
      stripAnsiStyles(frame)
        .split('\n')
        .every((row) => row.length <= 60),
    ).toBe(true);

    ui.stdin.write(DOWN);
    await flushEffects();
    const scrolled = ui.lastFrame() ?? '';
    expect(scrolled).not.toBe(frame);
    // Scrolling never costs the keys: the hint row is chrome, not part of the document.
    expect(scrolled.split('\n').find((row) => row.includes('r retry'))).toBe(hint);

    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write(ESC);
    await tick();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it('sanitizes diagnostic and failure text before rendering it', async () => {
    const esc = '\u001b';
    const bel = '\u0007';
    const readiness = report([
      {
        id: `visible-id${esc}]0;hidden-id${bel}`,
        severity: 'blocker',
        summary: `visible-summary${esc}]0;hidden-summary${bel}`,
        fix: `visible-fix${esc}]0;hidden-fix${bel}`,
        details: [`visible-detail${esc}]0;hidden-detail${bel}`],
      },
    ]);
    const ui = renderPanel({
      state: {
        kind: 'failed',
        report: readiness,
        error: new Error(`visible-error${esc}]0;hidden-error${bel}`),
      },
    });

    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('visible-summary');
    expect(frame).toContain('visible-error');
    expect(frame).not.toContain('hidden-id');
    expect(frame).not.toContain('hidden-summary');
    expect(frame).not.toContain('hidden-fix');
    expect(frame).not.toContain('hidden-detail');
    expect(frame).not.toContain('hidden-error');
    ui.unmount();
  });

  it('keeps preparation actions inactive behind an overlay', async () => {
    overlayStore.open('settings');
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    const ui = renderPanel({
      state: { kind: 'blocked', report: report([check('runner', 'blocker')]) },
      onRetry,
      onBack,
      onOpenSettings,
    });

    await flushEffects();
    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write(ESC);
    await tick();

    expect(onRetry).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('renders the caller-supplied tiered approval surface instead of generic actions', async () => {
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    const ui = renderPanel({
      state: { kind: 'preparing' },
      onRetry,
      onBack,
      onOpenSettings,
      approvalPrompt: <Text>Tiered approval</Text>,
    });

    await flushEffects();
    expect(ui.lastFrame()).toContain('Tiered approval');
    expect(ui.lastFrame()).not.toContain('Tool preparation');

    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write(ESC);
    await tick();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
    ui.unmount();
  });
});

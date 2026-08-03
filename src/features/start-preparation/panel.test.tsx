import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { StartPreparationPanel } from './panel.js';

function report(checks: ReadinessCheck[]): ReadinessReport {
  const blockers = checks.filter((check) => check.severity === 'blocker').length;
  const warnings = checks.filter((check) => check.severity === 'warning').length;
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir: '/project',
    status: blockers > 0 ? 'blocked' : 'ready',
    counts: { ok: 0, info: 0, warning: warnings, blocker: blockers },
    nextAction: {
      kind: blockers > 0 ? 'exit' : 'continue',
      label: blockers > 0 ? 'Exit' : 'Continue',
      reason: blockers > 0 ? 'Resolve the blockers.' : 'Tools are ready.',
    },
    sections: [{ id: 'runners', title: 'Runners', checks }],
    metadata: {},
  };
}

function check(id: string, severity: 'blocker' | 'warning'): ReadinessCheck {
  return { id, severity, summary: `${id} summary`, fix: `${id} fix` };
}

describe('StartPreparationPanel', () => {
  beforeEach(() => resetAllStores());
  afterEach(() => resetAllStores());

  it('sorts blockers first and exposes retry back settings and hidden count', async () => {
    const readiness = report([
      check('warning-one', 'warning'),
      check('warning-two', 'warning'),
      check('warning-three', 'warning'),
      check('warning-four', 'warning'),
      check('warning-five', 'warning'),
      check('blocker-one', 'blocker'),
      check('blocker-two', 'blocker'),
      check('blocker-three', 'blocker'),
    ]);
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    const ui = renderFeature(
      <StartPreparationPanel
        state={{ kind: 'blocked', report: readiness }}
        onRetry={onRetry}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
      />,
    );

    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame.indexOf('blocker-one')).toBeLessThan(frame.indexOf('warning-one'));
    expect(frame).toContain('4 checks hidden');
    expect(frame).toContain('r retry');
    expect(frame).toContain('esc back');
    expect(frame).toContain('s settings');

    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write('\x1b');
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
      },
    ]);
    const ui = renderFeature(
      <StartPreparationPanel
        state={{
          kind: 'failed',
          report: readiness,
          error: new Error(`visible-error${esc}]0;hidden-error${bel}`),
        }}
        onRetry={vi.fn()}
        onBack={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('visible-summary');
    expect(frame).toContain('visible-error');
    expect(frame).not.toContain('hidden-id');
    expect(frame).not.toContain('hidden-summary');
    expect(frame).not.toContain('hidden-fix');
    expect(frame).not.toContain('hidden-error');
    ui.unmount();
  });

  it('keeps preparation actions inactive behind an overlay', async () => {
    overlayStore.open('settings');
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    const ui = renderFeature(
      <StartPreparationPanel
        state={{ kind: 'blocked', report: report([check('runner', 'blocker')]) }}
        onRetry={onRetry}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
      />,
    );

    await flushEffects();
    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write('\x1b');
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
    const ui = renderFeature(
      <StartPreparationPanel
        state={{ kind: 'preparing' }}
        onRetry={onRetry}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
        approvalPrompt={<Text>Tiered approval</Text>}
      />,
    );

    await flushEffects();
    expect(ui.lastFrame()).toContain('Tiered approval');
    expect(ui.lastFrame()).not.toContain('Preparing your tools');

    ui.stdin.write('r');
    await flushEffects();
    ui.stdin.write('\x1b');
    await tick();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
    ui.unmount();
  });
});

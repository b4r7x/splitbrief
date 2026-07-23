import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { buildReadinessReport } from '../../../core/readiness/checks/build.js';
import { ReadinessPanel } from './readiness-panel.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';

function blockedReport(): ReadinessReport {
  return buildReadinessReport({
    projectDir: '/tmp/project',
    configLoad: {
      state: 'missing',
      path: '/tmp/project/.diptych/config.yaml',
      warnings: [],
    },
    packageScripts: {
      packageJsonExists: false,
      scripts: {},
    },
    repo: {
      isGitRepo: true,
      hasCommits: true,
      dirtyFiles: [],
      untrackedFiles: [],
    },
  });
}

describe('ReadinessPanel', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('hides the fix hint and does nothing on Enter when no fix is available', async () => {
    const onDismiss = vi.fn();
    const ui = renderFeature(<ReadinessPanel report={blockedReport()} onDismiss={onDismiss} />);

    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Readiness');
    expect(frame).toContain('Blocked');
    expect(frame).toContain('required');
    expect(frame).toContain('dismiss');
    expect(frame).not.toContain('open fix');

    ui.stdin.write('\r');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('Blocked');
    expect(onDismiss).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('shows the fix hint and runs the fix on Enter when onOpenFix is provided', async () => {
    const onOpenFix = vi.fn();
    const onDismiss = vi.fn();
    const ui = renderFeature(
      <ReadinessPanel report={blockedReport()} onOpenFix={onOpenFix} onDismiss={onDismiss} />,
    );
    await tick();
    expect(ui.lastFrame() ?? '').toContain('open fix');

    ui.stdin.write('\r');
    await tick();
    expect(onOpenFix).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('exposes no per-row focus cursor or arrow navigation', async () => {
    const onOpenFix = vi.fn();
    const ui = renderFeature(<ReadinessPanel report={blockedReport()} onOpenFix={onOpenFix} />);
    await tick();
    const before = ui.lastFrame() ?? '';
    expect(before).not.toContain('▌');

    ui.stdin.write('\x1b[B');
    ui.stdin.write('\x1b[A');
    await tick();
    expect(ui.lastFrame() ?? '').toBe(before);
    expect(onOpenFix).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('renders check details for readiness failures', async () => {
    const report = blockedReport();
    const check = report.sections[0]?.checks[0];
    if (!check) throw new Error('missing readiness check');
    check.details = ['config could not be read'];

    const ui = renderFeature(<ReadinessPanel report={report} />);
    await tick();

    expect(ui.lastFrame() ?? '').toContain('config could not be read');
    ui.unmount();
  });

  it('drops detail lines under width pressure while keeping the fix line', async () => {
    const report = blockedReport();
    const check = report.sections[0]?.checks[0];
    if (!check) throw new Error('missing readiness check');
    check.details = ['uncommitted files'];
    check.fix = 'go local';

    terminalSizeStore.__testReset({ cols: 48 });
    const ui = renderFeature(<ReadinessPanel report={report} />);
    await tick();

    const narrow = ui.lastFrame() ?? '';
    expect(narrow).toContain('blocker');
    expect(narrow).toContain('go local');
    expect(narrow).not.toContain('uncommitted files');

    terminalSizeStore.__testReset({ cols: 100 });
    await tick();
    expect(ui.lastFrame() ?? '').toContain('uncommitted files');
    ui.unmount();
  });

  it('strips terminal control sequences from rendered check and next-action text', async () => {
    const esc = '\u001b';
    const bel = '\u0007';
    const report = blockedReport();
    const blocker = report.sections
      .flatMap((section) => section.checks)
      .find((check) => check.severity === 'blocker' || check.severity === 'warning');
    if (!blocker) throw new Error('missing notable readiness check');

    blocker.summary = `SUMVIS${esc}]0;SUMHIDE${bel}`;
    blocker.details = [`DETVIS${esc}]0;DETHIDE${bel}`];
    blocker.fix = `FIXVIS${esc}]0;FIXHIDE${bel}`;
    report.nextAction = {
      ...report.nextAction,
      label: `LBLVIS${esc}]0;LBLHIDE${bel}`,
      reason: `RSNVIS${esc}]0;RSNHIDE${bel}`,
    };

    terminalSizeStore.__testReset({ cols: 100 });
    const ui = renderFeature(<ReadinessPanel report={report} />);
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('SUMHIDE');
    expect(frame).not.toContain('DETHIDE');
    expect(frame).not.toContain('FIXHIDE');
    expect(frame).not.toContain('LBLHIDE');
    expect(frame).not.toContain('RSNHIDE');
    expect(frame).toContain('SUMVIS');
    expect(frame).toContain('LBLVIS');
    ui.unmount();
  });

  it('ignores q and Escape while an overlay is open, then dismisses twice after it closes', async () => {
    overlayStore.open('settings');
    const onDismiss = vi.fn();
    const ui = renderFeature(<ReadinessPanel report={blockedReport()} onDismiss={onDismiss} />);
    await tick();

    ui.stdin.write('q');
    await tick();
    ui.stdin.write('\x1b');
    await tick();
    expect(onDismiss).not.toHaveBeenCalled();

    overlayStore.close();
    await tick();
    ui.stdin.write('q');
    await tick();
    ui.stdin.write('\x1b');
    await tick();
    expect(onDismiss).toHaveBeenCalledTimes(2);
    ui.unmount();
  });
});

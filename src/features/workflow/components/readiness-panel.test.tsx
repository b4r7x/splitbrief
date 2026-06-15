import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { buildReadinessReport } from '../../../core/readiness/checks/build.js';
import { ReadinessPanel } from './readiness-panel.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';

const exit = vi.fn();

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useApp: () => ({ exit }),
  };
});

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
    exit.mockClear();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders blocker action and does not continue on Enter', async () => {
    const ui = renderFeature(<ReadinessPanel report={blockedReport()} />);

    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Run Readiness');
    expect(frame).toContain('blocked');
    expect(frame).toContain('Required:');

    ui.stdin.write('\r');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('blocked');
    expect(exit).not.toHaveBeenCalled();
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

  it('exits on q and Escape when no overlay is open', async () => {
    const ui = renderFeature(<ReadinessPanel report={blockedReport()} />);
    await tick();

    ui.stdin.write('q');
    await tick();
    expect(exit).toHaveBeenCalledOnce();

    ui.stdin.write('\x1b');
    await tick();
    expect(exit).toHaveBeenCalledTimes(2);
    ui.unmount();
  });

  it('ignores q and Escape while an overlay is open, honours them after it closes', async () => {
    overlayStore.open('settings');
    const ui = renderFeature(<ReadinessPanel report={blockedReport()} />);
    await tick();

    // The panel sits behind the overlay; keys aimed at the overlay must not quit the app.
    ui.stdin.write('q');
    await tick();
    ui.stdin.write('\x1b');
    await tick();
    expect(exit).not.toHaveBeenCalled();

    // Closing the overlay hands input back to the panel and the same key is honoured.
    overlayStore.close();
    await tick();
    ui.stdin.write('q');
    await tick();
    expect(exit).toHaveBeenCalledOnce();
    ui.unmount();
  });
});

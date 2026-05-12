import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
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
});

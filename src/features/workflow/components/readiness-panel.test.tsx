import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { buildReadinessReport } from '../../../core/readiness/checks.js';
import { ReadinessPanel } from './readiness-panel.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';

function warningReport(): ReadinessReport {
  return buildReadinessReport({
    projectDir: '/tmp/project',
    config: makeConfig({ validation: { typecheck: false } }),
    configLoad: {
      state: 'loaded',
      path: '/tmp/project/.diptych/config.yaml',
      warnings: [],
    },
    packageScripts: {
      packageJsonExists: true,
      scripts: { test: 'vitest run' },
    },
    repo: {
      isGitRepo: true,
      dirtyFiles: [],
      untrackedFiles: [],
    },
  });
}

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

  it('renders warnings and continues on Enter', async () => {
    const onContinue = vi.fn();
    const ui = renderFeature(<ReadinessPanel report={warningReport()} onContinue={onContinue} />);

    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Run Readiness');
    expect(frame).toContain('ready-with-warnings');
    expect(frame).toContain('validation.disabled');

    ui.stdin.write('\r');
    await tick(20);
    expect(onContinue).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('does not continue on blockers', async () => {
    const onContinue = vi.fn();
    const ui = renderFeature(<ReadinessPanel report={blockedReport()} onContinue={onContinue} />);

    await tick();
    expect(ui.lastFrame() ?? '').toContain('blocked');

    ui.stdin.write('\r');
    await tick(20);
    expect(onContinue).not.toHaveBeenCalled();
    ui.unmount();
  });
});

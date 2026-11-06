import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { findVisualScenario } from './catalog.js';
import type { FixtureLifecycle } from './fixtures/common.js';
import { createSetupFixture, VISUAL_FIXTURE_PROJECT_DIR } from './fixtures/screen-fixtures.js';

let fixture: FixtureLifecycle;

afterEach(async () => {
  await fixture.teardown();
});

it.each(['initial', 'saved'] as const)(
  'gives the %s Setup fixture its own repository that ignores .splitbrief/',
  async (state) => {
    const scenario = findVisualScenario('setup-saved');
    if (scenario === undefined) throw new Error('Expected setup-saved scenario');
    const checkpoint = scenario.checkpoints[0];
    const viewport = scenario.viewports[0];
    if (checkpoint === undefined || viewport === undefined) {
      throw new Error('Expected checkpoint and viewport in setup-saved scenario');
    }
    const context = { scenario, checkpoint, viewport };
    fixture = createSetupFixture(state);
    await fixture.setup(context);
    expect(
      realpathSync(
        spawnSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: VISUAL_FIXTURE_PROJECT_DIR,
          encoding: 'utf8',
        }).stdout.trim(),
      ),
    ).toBe(realpathSync(VISUAL_FIXTURE_PROJECT_DIR));
    expect(
      spawnSync('git', ['check-ignore', '-q', '.splitbrief/config.yaml'], {
        cwd: VISUAL_FIXTURE_PROJECT_DIR,
      }).status,
    ).toBe(0);
  },
);

it('gives the first-save Setup fixture its own repository without the .splitbrief/ rule', async () => {
  const scenario = findVisualScenario('setup-saved');
  if (scenario === undefined) throw new Error('Expected setup-saved scenario');
  const checkpoint = scenario.checkpoints[0];
  const viewport = scenario.viewports[0];
  if (checkpoint === undefined || viewport === undefined) {
    throw new Error('Expected checkpoint and viewport in setup-saved scenario');
  }
  const context = { scenario, checkpoint, viewport };
  fixture = createSetupFixture('saved-ignore-rule');
  await fixture.setup(context);
  expect(
    realpathSync(
      spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: VISUAL_FIXTURE_PROJECT_DIR,
        encoding: 'utf8',
      }).stdout.trim(),
    ),
  ).toBe(realpathSync(VISUAL_FIXTURE_PROJECT_DIR));
  expect(
    spawnSync('git', ['check-ignore', '-q', '.splitbrief/config.yaml'], {
      cwd: VISUAL_FIXTURE_PROJECT_DIR,
    }).status,
  ).toBe(1);
});

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { findVisualScenario } from './catalog.js';
import type { FixtureLifecycle } from './fixtures/common.js';
import { createSetupFixture, VISUAL_FIXTURE_PROJECT_DIR } from './fixtures/screen-fixtures.js';

type SetupFixtureState = Parameters<typeof createSetupFixture>[0];

let fixture: FixtureLifecycle;

afterEach(async () => {
  await fixture.teardown();
});

async function setupFixture(state: SetupFixtureState): Promise<void> {
  const scenario = findVisualScenario('setup-saved');
  if (scenario === undefined) throw new Error('Expected setup-saved scenario');
  const checkpoint = scenario.checkpoints[0];
  const viewport = scenario.viewports[0];
  if (checkpoint === undefined || viewport === undefined) {
    throw new Error('Expected checkpoint and viewport in setup-saved scenario');
  }
  fixture = createSetupFixture(state);
  await fixture.setup({ scenario, checkpoint, viewport });
}

function expectFixtureRepository(ignoreStatus: number): void {
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
  ).toBe(ignoreStatus);
}

it.each(['initial', 'saved'] as const)(
  'gives the %s Setup fixture its own repository that ignores .splitbrief/',
  async (state) => {
    await setupFixture(state);
    expectFixtureRepository(0);
  },
);

it('gives the first-save Setup fixture its own repository without the .splitbrief/ rule', async () => {
  await setupFixture('saved-ignore-rule');
  expectFixtureRepository(1);
});

import { afterEach, expect, it, vi } from 'vitest';
import { overlayFixtureRegistry } from '../testing/visual/fixtures/overlay-fixtures.js';
import { screenFixtureRegistry } from '../testing/visual/fixtures/screen-fixtures.js';
import { workflowFixtureRegistry } from '../testing/visual/fixtures/workflow/registry.js';
import { runTuiPreview } from './tui-preview.js';

afterEach(() => vi.restoreAllMocks());

it('lists exactly the scenarios its interactive session can open', async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });

  expect(await runTuiPreview(['--list'])).toBe(0);

  const listed = output
    .join('')
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((row) => row.split('\t')[0]);
  const registered = [
    ...workflowFixtureRegistry.keys(),
    ...screenFixtureRegistry.keys(),
    ...overlayFixtureRegistry.keys(),
  ];
  expect(listed.sort()).toEqual(registered.sort());
});

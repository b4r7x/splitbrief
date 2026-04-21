import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '../../../testing/helpers/ink.js';
import { makeConfig } from '../../../testing/helpers/factories/config.js';
import { makeSummary } from '../../../testing/helpers/factories/summary.js';
import { resetAllStores } from '../../../testing/helpers/stores.js';
import { configStore } from '../../stores/project/config.js';
import { routerStore } from '../../stores/navigation/router.js';
import { SummaryScreen } from './screen.js';

describe('SummaryScreen', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders the persisted mode from the summary', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ mode: 'standard' }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Mode');
    expect(frame).toContain('standard');

    ui.unmount();
  });

  it('does not label old summaries with the current live config mode', () => {
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'quick' } }) });
    routerStore.init({ screen: 'summary', summary: makeSummary() });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('Mode');
    expect(frame).not.toContain('quick');

    ui.unmount();
  });
});

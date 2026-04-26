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

  it('uses task compiler language in the summary header', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ totalTasks: 5, completedByLocal: 4, escalatedToPlanner: 1 }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Task Brief');
    expect(frame).toContain('Implementer completed');
    expect(frame).toContain('locally');

    ui.unmount();
  });

  it('renders "quality n/a" when no briefQuality present', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary() });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('quality n/a');

    ui.unmount();
  });

  it('renders brief quality score when briefQuality is present', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ briefQuality: { score: 0.8, passed: true, errorCount: 0, warningCount: 2 } }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('quality 0.80');
    expect(frame).toContain('2 warnings');

    ui.unmount();
  });

  it('renders drift warning count when driftSummary is present', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ driftSummary: { passed: false, score: 0.84, errorCount: 0, warningCount: 1 } }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Drift');
    expect(frame).toContain('1 warning');

    ui.unmount();
  });

  it('does not render "full" mode label anywhere', () => {
    routerStore.init({ screen: 'summary', summary: makeSummary({ mode: 'standard' }) });

    const ui = renderFeature(<SummaryScreen commands={[]} onSlashCommand={() => {}} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('full');

    ui.unmount();
  });
});

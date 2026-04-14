import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const loadStateMock = vi.fn();
const listSessionsMock = vi.fn();
const getSessionDirMock = vi.fn<(scope: 'project' | 'global', projectDir: string) => string>();
const aggregateSessionCostsMock = vi.fn();
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

vi.mock('../../core/state/persistence.js', () => ({ loadState: (dir: string) => loadStateMock(dir) }));
vi.mock('../../core/sessions/io.js', () => ({
  listSessions: (dir: string) => listSessionsMock(dir),
  getSessionDir: (scope: 'project' | 'global', projectDir: string) => getSessionDirMock(scope, projectDir),
}));
vi.mock('../../core/sessions/analytics.js', () => ({
  aggregateSessionCosts: (sessions: unknown[]) => aggregateSessionCostsMock(sessions),
}));
vi.mock('../../core/state/selectors.js', () => ({
  getCompletedTaskIds: () => [],
  getEscalatedTaskIds: () => [],
  getFailedTaskIds: () => [],
}));
vi.mock('../../core/providers.js', () => ({ getProviderDisplayName: (id: string) => id }));
vi.mock('../../core/model-display.js', () => ({ formatModelName: (m: string) => m }));
vi.mock('../workflow.js', () => ({ resolveProjectDir: (d?: string) => d ?? '/cwd' }));

const { registerStatusCommand } = await import('./status.js');

function runStatus(args: string[]): void {
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program);
  program.parse(['node', 'diptych', 'status', ...args]);
}

describe('status command', () => {
  beforeEach(() => {
    consoleSpy.mockClear();
    loadStateMock.mockReset();
    listSessionsMock.mockReset();
    getSessionDirMock.mockReset();
    aggregateSessionCostsMock.mockReset();
    getSessionDirMock.mockReturnValue('/some/dir');
    listSessionsMock.mockReturnValue([]);
    aggregateSessionCostsMock.mockReturnValue({
      completedSessions: 0,
      totalCost: 0,
      totalSavings: 0,
      averageSavingsPercentage: 0,
      averageLocalCompletionRate: 0,
      providerTotals: {},
    });
  });

  describe('no active workflow', () => {
    beforeEach(() => {
      loadStateMock.mockReturnValue(null);
    });

    it('prints "No active workflow."', () => {
      runStatus([]);
      const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toContain('No active workflow.');
    });

    it('includes a hint about --history when flag is not used', () => {
      runStatus([]);
      const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toMatch(/--history/);
    });

    it('does not include the --history hint when --history is already passed', () => {
      runStatus(['--history']);
      const hintCalls = consoleSpy.mock.calls
        .map(c => String(c[0]))
        .filter(s => s.includes('--history') && s.includes('Run'));
      expect(hintCalls).toHaveLength(0);
    });

    it('shows cost history when --history is passed', () => {
      aggregateSessionCostsMock.mockReturnValue({
        completedSessions: 2,
        totalCost: 1.5,
        totalSavings: 0.8,
        averageSavingsPercentage: 53,
        averageLocalCompletionRate: 70,
        providerTotals: {},
      });
      runStatus(['--history']);
      const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toContain('No active workflow.');
      expect(output).toMatch(/Cost History/);
    });
  });

  describe('active workflow', () => {
    beforeEach(() => {
      loadStateMock.mockReturnValue({
        feature: 'add auth',
        phase: 'implementing',
        currentTaskIndex: 1,
        tasks: [{}, {}],
        startedAt: '2024-01-01T00:00:00Z',
        plannerTool: null,
        plannerModel: null,
        implementerTool: null,
        implementerModel: null,
      });
    });

    it('prints workflow status', () => {
      runStatus([]);
      const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toContain('add auth');
      expect(output).toContain('implementing');
    });

    it('also shows cost history when --history is passed', () => {
      aggregateSessionCostsMock.mockReturnValue({
        completedSessions: 1,
        totalCost: 0.5,
        totalSavings: 0.3,
        averageSavingsPercentage: 60,
        averageLocalCompletionRate: 75,
        providerTotals: {},
      });
      runStatus(['--history']);
      const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toContain('add auth');
      expect(output).toMatch(/Cost History/);
    });
  });
});

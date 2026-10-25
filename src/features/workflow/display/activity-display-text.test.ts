import { describe, expect, it } from 'vitest';
import { projectRunnerCallActivity } from '../../../engine/calls/activity.js';
import { normalizeRunnerCallWarning } from '../../../engine/calls/warnings.js';
import { runnerActivityLedgerItem } from './runner-activity-display.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayTextMiddleAtWords,
} from '../../../utils/display-text.js';
import { rowLeadingCells } from '../conversation-rows/row-markers.js';
import { getWorkflowContentWidth } from '../layout/rect.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from './activity-label-display.js';
import { fitCompactActivityDisplayLine } from './activity-display-text.js';

describe('fitCompactActivityDisplayLine', () => {
  it.each([
    [60, "rg --files --hidden -g … -g '!pnpm-lock.yaml'"],
    [80, "rg --files --hidden -g … -g '!yarn.lock' -g '!pnpm-lock.yaml'"],
    [
      120,
      "rg --files --hidden -g '!node_modules' -g … -g '!package-lock.json' -g '!yarn.lock' -g '!pnpm-lock.yaml'",
    ],
  ])('keeps whole command tokens in a RUN row at %i columns', (cols, expected) => {
    const command =
      "rg --files --hidden -g '!node_modules' -g '!.git' -g '!package-lock.json' -g '!yarn.lock' -g '!pnpm-lock.yaml'";
    const label = displayActivityLabel('RUN').padEnd(ACTIVITY_LABEL_PAD);
    const rowCells = getWorkflowContentWidth({ cols, sidebarVisible: true });
    const prefixCells = rowLeadingCells('activity-child');
    const line = fitCompactActivityDisplayLine({
      label,
      value: command,
      valueFit: 'middle',
      rowCells,
      prefixCells,
    });

    expect(line.value).toBe(expected);
    expect(line.text).toBe(`${label}  ${expected}`);
    const value = line.text.slice(label.length + 2);
    expect(value).not.toMatch(/(?:^|\s)'(?:\s|$)/u);
    for (const token of value.split(/\s+/u)) {
      expect([...command.split(/\s+/u), '…']).toContain(token);
    }
    expect(prefixCells + getTerminalCellWidth(line.text)).toBeLessThanOrEqual(rowCells);
  });

  it('uses the available RUN value budget for a complete test path', () => {
    const line = fitCompactActivityDisplayLine({
      label: 'run',
      value:
        'npm exec vitest run src/engine/calls/activity.test.ts src/features/workflow/display/activity-display-text.test.ts --reporter=verbose',
      rowCells: 107,
      prefixCells: 2,
    });

    expect(line.value).toBe(
      'npm exec vitest run … src/features/workflow/display/activity-display-text.test.ts --reporter=verbose',
    );
    expect(line.text).toBe(`run  ${line.value}`);
    expect(2 + getTerminalCellWidth(line.text)).toBeLessThanOrEqual(107);
  });

  it('fits a long run command into one child activity row while preserving the command and SKILL.md tail', () => {
    const rowCells = 56;
    const line = fitCompactActivityDisplayLine({
      label: 'run',
      value: "sed -n '1,260p' /Users/alice/.agents/library/codebase-exploration/SKILL.md",
      rowCells,
      prefixCells: getTerminalCellWidth('| '),
    });

    expect(line.text.startsWith("run  sed -n '1,260p'")).toBe(true);
    expect(line.text.endsWith('SKILL.md')).toBe(true);
    expect(line.text).toContain('…');
    expect(line.text).not.toContain('\n');
    expect(getTerminalCellWidth(`| ${line.text}`)).toBeLessThanOrEqual(rowCells);
  });

  it.each(['src/long-command-path/'.repeat(6), '界🙂e\u0301/'.repeat(24)])(
    'reveals the complete projected command after a narrow-to-wide resize: %s',
    (path) => {
      const command = `npm test ${path}activity.test.ts`;
      const activity = projectRunnerCallActivity(
        {
          ts: 1,
          callId: 'width-test',
          role: 'implementer',
          backendKind: 'cli',
          runnerName: 'claude-code',
          model: 'test',
          attempt: 1,
          type: 'call_tool_use_delta',
          channel: 'tool',
          toolUseId: 'command',
          name: 'Bash',
          inputDelta: JSON.stringify({ command }),
        },
        1,
        '/project',
      );
      expect(activity).not.toBeNull();
      if (activity === null) return;
      const item = runnerActivityLedgerItem(activity);
      expect(item).not.toBeNull();
      if (item === null) return;
      const prefix = '  └─ ';
      const renderAtWidth = (rowCells: number) =>
        fitCompactActivityDisplayLine({
          label: item.label,
          value: item.value,
          valueFit: item.fitMode,
          rowCells,
          prefixCells: getTerminalCellWidth(prefix),
        });
      const narrow = renderAtWidth(60);
      expect(narrow.text).toContain('…');
      expect(narrow.text).not.toContain('\n');
      expect(getTerminalCellWidth(prefix + narrow.text)).toBeLessThanOrEqual(60);
      const fullText = `${item.label}  ${command}`;
      const exactWidth = getTerminalCellWidth(prefix + fullText);
      expect(renderAtWidth(exactWidth - 1).text).toContain('…');
      expect(renderAtWidth(exactWidth).text).toBe(fullText);
      expect(renderAtWidth(400).value).toBe(command);
      expect(renderAtWidth(60)).toEqual(narrow);
    },
  );

  it('preserves the filename tail for file activity values', () => {
    const rowCells = 42;
    const line = fitCompactActivityDisplayLine({
      label: 'read',
      value: '/Users/alice/Projects/splitbrief/src/features/workflow/display/package.json',
      rowCells,
      prefixCells: getTerminalCellWidth('| '),
    });

    expect(line.text.startsWith('read  …')).toBe(true);
    expect(line.text.endsWith('workflow/display/package.json')).toBe(true);
    expect(getTerminalCellWidth(`| ${line.text}`)).toBeLessThanOrEqual(rowCells);
  });

  it('budgets header activity text for the rendered header prefix', () => {
    const rowCells = 36;
    const line = fitCompactActivityDisplayLine({
      label: 'implementer activity',
      value: '12 updates [claude-code/sonnet]',
      rowCells,
      prefixCells: getTerminalCellWidth('> '),
    });

    expect(line.text).toContain('…');
    expect(getTerminalCellWidth(`> ${line.text}`)).toBeLessThanOrEqual(rowCells);
  });
});

describe('a WARN row', () => {
  const usage = "You've used 75% of your Claude Code weekly limit · resets Jul 16, 18:00";
  const prefixCells = rowLeadingCells('activity-child');

  function renderWarning(message: string, cols: number) {
    const activity = projectRunnerCallActivity(
      {
        ts: 1,
        callId: 'warn-fit',
        role: 'planner',
        backendKind: 'cli',
        runnerName: 'claude-code',
        model: 'opus',
        attempt: 0,
        type: 'call_warning',
        warning: normalizeRunnerCallWarning({ code: 'claude_rate_limit', message }),
      },
      1,
      '/project',
    );
    if (activity === null) throw new Error('expected activity');
    const item = runnerActivityLedgerItem(activity);
    if (item === null) throw new Error('expected a ledger item');
    const label = displayActivityLabel(item.label).padEnd(ACTIVITY_LABEL_PAD);
    const rowCells = getWorkflowContentWidth({ cols, sidebarVisible: false });
    const line = fitCompactActivityDisplayLine({
      label,
      value: item.value,
      valueFit: item.fitMode,
      rowCells,
      prefixCells,
    });
    const valueCells = rowCells - prefixCells - getTerminalCellWidth(`${label}  `);
    return { line, rowCells, valueCells };
  }

  it.each([
    [60, "You've used 75% of your Claude Code weekly limit"],
    [80, "You've used 75% of your Claude Code weekly limit"],
    [120, usage],
  ])('drops whole trailing segments at %i columns', (cols, expected) => {
    const { line, rowCells } = renderWarning(usage, cols);

    expect(line.value).toBe(expected);
    expect(prefixCells + getTerminalCellWidth(line.text)).toBeLessThanOrEqual(rowCells);
  });

  it('cuts the middle when the first segment alone does not fit', () => {
    const { line, valueCells } = renderWarning(usage, 50);

    expect(line.value).toBe(truncateTerminalDisplayTextMiddleAtWords(usage, valueCells));
  });

  it('cuts the middle when the text has no segments', () => {
    const message = "You've used 75% of your Claude Code weekly limit, it resets Thursday";
    const { line, valueCells } = renderWarning(message, 60);

    expect(line.value).toBe(truncateTerminalDisplayTextMiddleAtWords(message, valueCells));
  });
});

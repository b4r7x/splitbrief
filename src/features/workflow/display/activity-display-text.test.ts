import { describe, expect, it } from 'vitest';
import { projectRunnerCallActivity } from '../../../engine/calls/activity.js';
import { runnerActivityLedgerItem } from './runner-activity-display.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { fitCompactActivityDisplayLine } from './activity-display-text.js';

describe('fitCompactActivityDisplayLine', () => {
  it('fits a long run command into one child activity row while preserving the command and SKILL.md tail', () => {
    const rowCells = 56;
    const line = fitCompactActivityDisplayLine({
      label: 'run',
      value: "sed -n '1,260p' /Users/dev/.agents/library/codebase-exploration/SKILL.md",
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
      );
      expect(activity).not.toBeNull();
      if (activity === null) return;
      const item = runnerActivityLedgerItem(activity);
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
      value: '/Users/dev/Projects/splitbrief/src/features/workflow/display/package.json',
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

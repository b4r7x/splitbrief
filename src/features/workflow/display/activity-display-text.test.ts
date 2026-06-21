import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { fitCompactActivityDisplayLine } from './activity-display-text.js';

describe('fitCompactActivityDisplayLine', () => {
  it('fits a long run command into one child activity row while preserving the command and SKILL.md tail', () => {
    const rowCells = 56;
    const line = fitCompactActivityDisplayLine({
      label: 'run',
      value: "sed -n '1,260p' /Users/voitz/.agents/library/codebase-exploration/SKILL.md",
      rowCells,
      prefixCells: getTerminalCellWidth('| '),
    });

    expect(line.text.startsWith("run  sed -n '1,260p'")).toBe(true);
    expect(line.text.endsWith('SKILL.md')).toBe(true);
    expect(line.text).toContain('…');
    expect(line.text).not.toContain('\n');
    expect(getTerminalCellWidth(`| ${line.text}`)).toBeLessThanOrEqual(rowCells);
  });

  it('fits a package command into one child activity row while preserving package.json', () => {
    const rowCells = 50;
    const line = fitCompactActivityDisplayLine({
      label: 'run',
      value: 'node scripts/inspect-package.js /Users/voitz/Projects/tiny-spec/package.json',
      rowCells,
      prefixCells: getTerminalCellWidth('| '),
    });

    expect(line.text.startsWith('run  node scripts/')).toBe(true);
    expect(line.text.endsWith('package.json')).toBe(true);
    expect(line.text).toContain('…');
    expect(getTerminalCellWidth(`| ${line.text}`)).toBeLessThanOrEqual(rowCells);
  });

  it('preserves the filename tail for file activity values', () => {
    const rowCells = 42;
    const line = fitCompactActivityDisplayLine({
      label: 'read',
      value: '/Users/voitz/Projects/tiny-spec/src/features/workflow/display/package.json',
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

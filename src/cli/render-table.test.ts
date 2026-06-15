import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderTable } from './render-table.js';

interface Row {
  name: string;
  detail: string;
}

const original = process.stdout.columns;

function setColumns(value: number): void {
  Object.defineProperty(process.stdout, 'columns', { value, configurable: true });
}

beforeEach(() => {
  setColumns(20);
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: original, configurable: true });
});

describe('renderTable cell truncation', () => {
  it('marks truncated cells with an ellipsis instead of silently cutting them', () => {
    const lines = renderTable<Row>({
      columns: [
        { header: 'NAME', min: 4, value: (r) => r.name, shrink: true, truncate: true },
        { header: 'DETAIL', min: 4, value: (r) => r.detail },
      ],
      rows: [{ name: 'a-very-long-name-value', detail: 'and-a-very-long-detail-value' }],
    });

    const dataRow = lines[lines.length - 1] ?? '';
    expect(dataRow).toContain('…');
    expect(dataRow).not.toContain('a-very-long-name-value');
    expect(dataRow).toMatch(/^a-v…/);
  });

  it('leaves cells untouched when they fit within the column width', () => {
    setColumns(200);
    const lines = renderTable<Row>({
      columns: [
        { header: 'NAME', min: 4, value: (r) => r.name, shrink: true, truncate: true },
        { header: 'DETAIL', min: 4, value: (r) => r.detail },
      ],
      rows: [{ name: 'short', detail: 'tiny' }],
    });

    const dataRow = lines[lines.length - 1] ?? '';
    expect(dataRow).toContain('short');
    expect(dataRow).not.toContain('…');
  });
});

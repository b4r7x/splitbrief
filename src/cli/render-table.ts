import ansis from 'ansis';

export interface TableColumn<R> {
  header: string;
  min: number;
  value: (row: R) => string;
  shrink?: boolean;
  shrinkPriority?: number;
  truncate?: boolean;
}

export interface RenderTableOptions<R> {
  columns: TableColumn<R>[];
  rows: R[];
  gap?: number;
  boldHeader?: boolean;
  separator?: boolean;
}

function naturalWidth<R>(column: TableColumn<R>, cells: string[]): number {
  return Math.max(column.min, column.header.length, ...cells.map((cell) => cell.length));
}

function shrinkToFit<R>(
  columns: TableColumn<R>[],
  widths: number[],
  gap: number,
  terminalWidth: number,
): void {
  const totalGap = gap * Math.max(0, columns.length - 1);
  let total = widths.reduce((sum, w) => sum + w, 0) + totalGap;
  if (total <= terminalWidth) return;

  const order = columns
    .map((column, i) => ({ i, priority: column.shrinkPriority ?? i }))
    .filter(({ i }) => columns[i]?.shrink)
    .sort((a, b) => a.priority - b.priority);

  for (const { i } of order) {
    if (total <= terminalWidth) break;
    const overflow = total - terminalWidth;
    const current = widths[i] ?? 0;
    const reduced = Math.max(columns[i]?.min ?? 0, current - overflow);
    total -= current - reduced;
    widths[i] = reduced;
  }
}

function cell(value: string, width: number, opts: { truncate: boolean; pad: boolean }): string {
  if (opts.truncate && value.length > width) return `${value.slice(0, Math.max(0, width - 1))}…`;
  return opts.pad ? value.padEnd(width) : value;
}

export function renderTable<R>(opts: RenderTableOptions<R>): string[] {
  const { columns, rows } = opts;
  const gap = opts.gap ?? 2;
  const separator = ' '.repeat(gap);
  const cellsByColumn = columns.map((column) => rows.map((row) => column.value(row)));
  const widths = columns.map((column, i) => naturalWidth(column, cellsByColumn[i] ?? []));

  shrinkToFit(columns, widths, gap, process.stdout.columns ?? 80);

  const lastIndex = columns.length - 1;
  const headerCells = columns.map((column, i) => {
    const text = i === lastIndex ? column.header : column.header.padEnd(widths[i] ?? 0);
    return opts.boldHeader ? ansis.bold(text) : text;
  });
  const lines = [headerCells.join(separator)];

  if (opts.separator) {
    const leadingWidth = widths.slice(0, lastIndex).reduce((sum, w) => sum + w + gap, 0);
    const sepWidth = leadingWidth + (columns[lastIndex]?.header.length ?? 0);
    lines.push(ansis.dim('-'.repeat(sepWidth)));
  }

  for (const row of rows) {
    const rowCells = columns.map((column, i) =>
      cell(column.value(row), widths[i] ?? 0, {
        truncate: column.truncate ?? false,
        pad: i !== lastIndex,
      }),
    );
    lines.push(rowCells.join(separator));
  }

  return lines;
}

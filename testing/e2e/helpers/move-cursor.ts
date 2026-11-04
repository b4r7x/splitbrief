import { expect, vi } from 'vitest';

const MAX_PRESSES = 8;

/** The rows that hold a cursor mark, so a press shows as a change here and nowhere else. */
function cursorRows(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.includes('▌'))
    .join('\n');
}

/**
 * Presses `key` until the row matching `row` holds the cursor. Each press waits for the
 * cursor to move before the next one, so a slow render cannot carry the cursor past the row.
 */
export async function moveCursorTo(
  text: () => string,
  write: (keys: string) => void,
  key: string,
  row: RegExp,
): Promise<void> {
  for (let presses = 0; !row.test(text()); presses++) {
    expect(presses, `the cursor did not reach ${row}`).toBeLessThan(MAX_PRESSES);
    const before = cursorRows(text());
    write(key);
    await vi.waitFor(() => expect(cursorRows(text())).not.toBe(before), { timeout: 10_000 });
  }
}

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'dangling-imports.mjs');

describe('dangling-imports', () => {
  let root: string;

  const write = (relPath: string, source: string): void => {
    const fullPath = join(root, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, source);
  };

  const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dangling-imports-'));
    write(
      'src/lib/x.ts',
      'export function real(): void {}\nexport default function main(): void {}\n',
    );
    write(
      'src/lib/x.test.ts',
      [
        "import { real } from './x.js';",
        "vi.mock('./x.js', async (importOriginal) => ({",
        '  ...(await importOriginal()),',
        '  real: vi.fn(),',
        '  default: vi.fn(),',
        "  ['computed']: 1,",
        '}));',
        'real();',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a tree whose imports, mock paths and mock factory keys resolve', () => {
    const result = run();

    expect(result.stdout).toBe('clean — 2 files scanned\n');
    expect(result.status).toBe(0);
  });

  it('names a mock path that resolves to no file', () => {
    write('src/lib/y.test.ts', "vi.mock('./gone.js');\n");

    const result = run();

    expect(result.stdout).toBe(
      '1 dangling mock path(s) in 1 file(s) of 3 scanned:\n\n  src/lib/y.test.ts:1 -> ./gone.js\n',
    );
    expect(result.status).toBe(1);
  });

  it('names a mock factory key that the mocked module does not export', () => {
    write('src/lib/z.test.ts', "vi.mock('./x.js', () => ({ moved: vi.fn() }));\n");

    const result = run();

    expect(result.stdout).toBe(
      "1 stale mock factory key(s) in 1 file(s) of 3 scanned:\n\n  src/lib/z.test.ts:1 -> ./x.js has no export 'moved'\n",
    );
    expect(result.status).toBe(1);
  });
});

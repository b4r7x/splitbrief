import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertPathConfined } from '../path-confinement.js';
import { error } from '../../utils/error.js';
import { gitBinary } from './client.js';

/** A file by its bytes and mode, a symlink by its target, or nothing. */
type Entry = { bytes: Buffer; mode: number } | { target: string } | null;

function quotedGitPath(path: string): string {
  const escaped = [...Buffer.from(path, 'utf8')]
    .map((byte) =>
      byte < 32 || byte >= 127
        ? `\\${byte.toString(8).padStart(3, '0')}`
        : byte === 34 || byte === 92
          ? `\\${String.fromCharCode(byte)}`
          : String.fromCharCode(byte),
    )
    .join('');
  return `"${escaped}"`;
}

/** Diff exact captured entries without touching the repository index or target. */
export async function diffFileEntries(input: {
  path: string;
  before: Entry;
  after: Entry;
}): Promise<string> {
  const { path, before, after } = input;
  const root = await mkdtemp(join(tmpdir(), 'splitbrief-review-diff-'));
  try {
    for (const [side, entry] of [
      ['a', before],
      ['b', after],
    ] as const) {
      const relative = `${side}/${path}`;
      assertPathConfined(path, join(root, side));
      if (entry === null) continue;
      const target = join(root, relative);
      await mkdir(dirname(target), { recursive: true });
      if ('target' in entry) {
        await symlink(entry.target, target);
        continue;
      }
      await writeFile(target, entry.bytes, { mode: 0o600 });
      await chmod(target, entry.mode);
    }
    const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    if (before === null && after === null) return '';
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(
        gitBinary(),
        [
          'diff',
          '--no-index',
          '--no-prefix',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--unified=0',
          '--',
          before === null ? nullPath : `a/${path}`,
          after === null ? nullPath : `b/${path}`,
        ],
        { cwd: root },
      );
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0 && code !== 1) {
          reject(error('review-diff-failed', `Could not diff captured review entry: ${path}`));
          return;
        }
        // Git uses the extant path twice for a create/delete header, and a file
        // replaced by a symlink is a delete and a create. Keep the ordinary a/b
        // spelling on every section so coverage readers see both sides consistently.
        const diff = Buffer.concat(chunks).toString('utf8');
        const header = `diff --git ${quotedGitPath(`a/${path}`)} ${quotedGitPath(`b/${path}`)}`;
        // Function names in hunk headers are unchanged context too. Keeping them
        // here would let drift attribute an operator's adjacent symbol to the run.
        resolve(diff.replace(/^diff --git .*$/gm, header).replace(/^(@@ .*? @@).*$/gm, '$1'));
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

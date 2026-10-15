import { getGitForDir, gitError, runGit } from './client.js';
import { hasCommits } from './repository.js';

export const GIT_EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type RunStartBase =
  | { kind: 'commit'; ref: string }
  | { kind: 'empty-tree'; ref: typeof GIT_EMPTY_TREE_HASH }
  | { kind: 'working-tree-only' };

// A run's captured head never changes, so one successful verify per project and
// head serves the whole run. A failure is not kept: a missing base throws on every
// call. The unborn case is not kept either, since a first commit turns it born.
const verifiedRunBases = new Set<string>();

export async function resolveRunStartBase(opts: {
  projectDir: string;
  head: string | null;
}): Promise<RunStartBase> {
  const { projectDir, head } = opts;
  if (head === null) {
    return (await hasCommits(projectDir))
      ? { kind: 'empty-tree', ref: GIT_EMPTY_TREE_HASH }
      : { kind: 'working-tree-only' };
  }
  const key = `${projectDir}\0${head}`;
  if (!verifiedRunBases.has(key)) {
    await runGit(`rev-parse --verify ${head}^{commit}`, () =>
      getGitForDir(projectDir).raw(['rev-parse', '--verify', `${head}^{commit}`]),
    );
    verifiedRunBases.add(key);
  }
  return { kind: 'commit', ref: head };
}

export async function getCurrentCommitSha(dir: string): Promise<string> {
  const sha = (
    await runGit('rev-parse HEAD', () => getGitForDir(dir).raw(['rev-parse', 'HEAD']))
  ).trim();
  if (sha.length === 0) {
    throw gitError.commandFailed('rev-parse HEAD', 'rev-parse HEAD returned empty output');
  }
  return sha;
}

export async function getCurrentBranch(dir: string): Promise<string> {
  return runGit('rev-parse --abbrev-ref HEAD', async () =>
    (await getGitForDir(dir).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
  );
}

export async function branchExists(dir: string, name: string): Promise<boolean> {
  return runGit('branch --list', async () => {
    const result = await getGitForDir(dir).branch(['--list', name]);
    return result.all.includes(name);
  });
}

export async function createBranch(dir: string, desiredName: string): Promise<string> {
  let name = desiredName;
  let suffix = 2;
  while (await branchExists(dir, name)) {
    if (suffix > 99) {
      throw gitError.branchNameCollision(desiredName);
    }
    name = `${desiredName}-${suffix}`;
    suffix++;
  }
  await runGit('checkout -b', () => getGitForDir(dir).checkoutLocalBranch(name));
  return name;
}

export async function showFileAtHead(dir: string, file: string): Promise<Buffer | null> {
  try {
    return await getGitForDir(dir).showBuffer([`HEAD:${file}`]);
  } catch {
    return null;
  }
}

async function readTreeEntryAtRef(
  dir: string,
  ref: string,
  file: string,
): Promise<string | undefined> {
  const tree = await runGit('ls-tree', () =>
    getGitForDir(dir).raw(['ls-tree', '-z', ref, '--', `:(literal)${file}`]),
  );
  return tree.split('\0').find((entry) => entry.slice(entry.indexOf('\t') + 1) === file);
}

export async function readFileModeAtHead(dir: string, file: string): Promise<number | null> {
  const row = await readTreeEntryAtRef(dir, 'HEAD', file);
  return row === undefined ? null : Number.parseInt(row.slice(0, 6), 8);
}

/** Read restoration material without checking out or modifying any index; a symlink by its target. */
export async function readEntryAtRef(
  dir: string,
  ref: string,
  file: string,
): Promise<
  { kind: 'file'; bytes: Buffer; mode: number } | { kind: 'symlink'; target: string } | null
> {
  if (ref === GIT_EMPTY_TREE_HASH) return null;
  const row = await readTreeEntryAtRef(dir, ref, file);
  if (row === undefined) return null;
  const match = /^(100644|100755|120000) blob ([a-f0-9]+)\t/.exec(row);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw gitError.commandFailed('ls-tree', `Cannot restore nonregular file: ${file}`);
  }
  const object = match[2];
  const bytes = await runGit('show', () => getGitForDir(dir).showBuffer([object]));
  return match[1] === '120000'
    ? { kind: 'symlink', target: bytes.toString('utf8') }
    : { kind: 'file', bytes, mode: Number.parseInt(match[1], 8) & 0o777 };
}

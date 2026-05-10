import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

type RepoFiles = Record<string, string>;

function writeObject(dir: string, type: 'blob' | 'tree' | 'commit', body: Buffer | string): string {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const stored = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
  const sha = createHash('sha1').update(stored).digest('hex');
  const objectDir = join(dir, '.git', 'objects', sha.slice(0, 2));
  mkdirSync(objectDir, { recursive: true });
  writeFileSync(join(objectDir, sha.slice(2)), deflateSync(stored));
  return sha;
}

type TreeNode = {
  files: Map<string, string>;
  dirs: Map<string, TreeNode>;
};

function emptyTree(): TreeNode {
  return { files: new Map(), dirs: new Map() };
}

function addTreeFile(root: TreeNode, file: string, blobSha: string): void {
  const parts = file.split('/');
  const name = parts.pop();
  if (!name) throw new Error(`invalid git fixture path: ${file}`);

  let node = root;
  for (const part of parts) {
    const existing = node.dirs.get(part);
    if (existing) {
      node = existing;
    } else {
      const next = emptyTree();
      node.dirs.set(part, next);
      node = next;
    }
  }
  node.files.set(name, blobSha);
}

function writeTree(dir: string, node: TreeNode): string {
  const entries = [
    ...Array.from(node.files, ([name, sha]) => ({ mode: '100644', name, sha })),
    ...Array.from(node.dirs, ([name, child]) => ({ mode: '40000', name, sha: writeTree(dir, child) })),
  ].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));

  const body = Buffer.concat(entries.map((entry) => Buffer.concat([
    Buffer.from(`${entry.mode} ${entry.name}\0`),
    Buffer.from(entry.sha, 'hex'),
  ])));

  return writeObject(dir, 'tree', body);
}

function writeIndex(dir: string, files: Array<{ path: string; blobSha: string; size: number }>): void {
  const entries: Buffer[] = [];

  for (const file of files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    const path = Buffer.from(file.path);
    if (path.length > 0xfff) throw new Error(`git fixture path is too long: ${file.path}`);

    const fixed = Buffer.alloc(62 + path.length + 1);
    let pos = 0;
    for (const field of [0, 0, 0, 0, 0, 0, 0o100644, 0, 0, file.size]) {
      fixed.writeUInt32BE(field, pos);
      pos += 4;
    }
    Buffer.from(file.blobSha, 'hex').copy(fixed, pos);
    pos += 20;
    fixed.writeUInt16BE(path.length, pos);
    pos += 2;
    path.copy(fixed, pos);
    pos += path.length;
    fixed[pos] = 0;
    pos += 1;

    const padding = (8 - (pos % 8)) % 8;
    entries.push(Buffer.concat([fixed.subarray(0, pos), Buffer.alloc(padding)]));
  }

  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(files.length, 8);

  const content = Buffer.concat([header, ...entries]);
  const checksum = createHash('sha1').update(content).digest();
  writeFileSync(join(dir, '.git', 'index'), Buffer.concat([content, checksum]));
}

function validateFixturePath(path: string): void {
  if (path.startsWith('/') || path.includes('..') || path.length === 0) {
    throw new Error(`invalid git fixture path: ${path}`);
  }
}

export function createTestGitRepo(dir: string, files: RepoFiles = {}): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });

  const repoFiles = { 'init.txt': 'init', ...files };
  const root = emptyTree();
  const indexEntries: Array<{ path: string; blobSha: string; size: number }> = [];

  for (const [path, content] of Object.entries(repoFiles)) {
    validateFixturePath(path);
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);

    const blobSha = writeObject(dir, 'blob', content);
    addTreeFile(root, path, blobSha);
    indexEntries.push({ path, blobSha, size: Buffer.byteLength(content) });
  }

  const treeSha = writeTree(dir, root);
  const timestamp = 1_700_000_000;
  const commit = [
    `tree ${treeSha}`,
    `author Test <test@test.com> ${timestamp} +0000`,
    `committer Test <test@test.com> ${timestamp} +0000`,
    '',
    'init',
    '',
  ].join('\n');
  const commitSha = writeObject(dir, 'commit', commit);

  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeIndex(dir, indexEntries);
}

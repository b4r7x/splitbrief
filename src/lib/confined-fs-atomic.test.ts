import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  constants,
  chmodSync,
  linkSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { link, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  confinedAtomicWriteFile,
  confinedAtomicWriteFileForTest,
  confinedAtomicWriteFileSync,
  confinedAtomicWriteFileSyncForTest,
  type ConfigRevision,
  type ConfinedAtomicWriteTestOperations,
  type ConfinedAtomicWriteSyncTestOperations,
} from './confined-fs-atomic.js';
import { readProcessStartTimeMs } from './process/start-time.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

function createAtomicTempDir(prefix: string): string {
  const dir = realpathSync(createTempDir(prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeFile(content = 'original bytes'): {
  dir: string;
  path: string;
  revision: ConfigRevision;
} {
  const dir = createAtomicTempDir('confined-atomic-write');
  const path = join(dir, 'config.yaml');
  writeFileSync(path, content, { mode: 0o600 });
  return { dir, path, revision: revisionFor(path) };
}

function revisionFor(path: string): ConfigRevision {
  const bytes = readFileSync(path);
  const stat = statSync(path, { bigint: true });
  return {
    rawSha256: createHash('sha256').update(bytes).digest('hex'),
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    },
  };
}

function temporaryFiles(dir: string): string[] {
  return readdirSync(dir).filter((entry) => entry.includes('.tmp.'));
}

function fault(message: string): Error {
  return Object.assign(new Error(message), { code: 'EIO' });
}

function faultingOperations(
  operation: 'open' | 'write' | 'fsync' | 'chmod' | 'read' | 'stat' | 'compare' | 'rename' | 'link',
): ConfinedAtomicWriteTestOperations {
  switch (operation) {
    case 'open':
      return { open: async () => Promise.reject(fault('open failed')) };
    case 'write':
      return { write: async () => Promise.reject(fault('write failed')) };
    case 'fsync':
      return { fsync: async () => Promise.reject(fault('file fsync failed')) };
    case 'chmod':
      return { chmod: async () => Promise.reject(fault('temporary mode failed')) };
    case 'read':
      return { read: async () => Promise.reject(fault('pre-rename read failed')) };
    case 'stat':
      return {
        stat: async (handle, target) => {
          if (target === 'target') throw fault('pre-rename fstat failed');
          return handle.stat({ bigint: true });
        },
      };
    case 'compare':
      return { compare: async () => Promise.reject(fault('compare failed')) };
    case 'rename':
      return { rename: async () => Promise.reject(fault('rename failed')) };
    case 'link':
      return { link: async () => Promise.reject(fault('link failed')) };
  }
}

function faultingSyncOperations(
  operation: 'open' | 'write' | 'fsync' | 'read' | 'stat' | 'compare' | 'rename' | 'link',
): ConfinedAtomicWriteSyncTestOperations {
  switch (operation) {
    case 'open':
      return {
        open: () => {
          throw fault('open failed');
        },
      };
    case 'write':
      return {
        write: () => {
          throw fault('write failed');
        },
      };
    case 'fsync':
      return {
        fsync: () => {
          throw fault('file fsync failed');
        },
      };
    case 'read':
      return {
        read: () => {
          throw fault('pre-rename read failed');
        },
      };
    case 'stat':
      return {
        stat: (handle, target) => {
          if (target === 'target') throw fault('pre-rename fstat failed');
          return fstatSync(handle, { bigint: true });
        },
      };
    case 'compare':
      return {
        compare: () => {
          throw fault('compare failed');
        },
      };
    case 'rename':
      return {
        rename: () => {
          throw fault('rename failed');
        },
      };
    case 'link':
      return {
        link: () => {
          throw fault('link failed');
        },
      };
  }
}

const concurrentChildScript = `
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const mode = process.env.SPLITBRIEF_CAS_MODE;
const target = process.env.SPLITBRIEF_CAS_TARGET;
const resultPath = process.env.SPLITBRIEF_CAS_RESULT;
const readyPath = process.env.SPLITBRIEF_CAS_READY;
const releasePath = process.env.SPLITBRIEF_CAS_RELEASE;
const content = process.env.SPLITBRIEF_CAS_CONTENT ?? '';
const sourcePath = process.env.SPLITBRIEF_CAS_SOURCE;
const crashPublish = process.env.SPLITBRIEF_CAS_CRASH_PUBLISH === '1';

function revisionFor(path) {
  const bytes = readFileSync(path);
  const stat = statSync(path, { bigint: true });
  return {
    rawSha256: createHash('sha256').update(bytes).digest('hex'),
    fileIdentity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs },
  };
}

function signalCompare() {
  appendFileSync(readyPath, String(process.pid) + '\\n', { flag: 'a', mode: 0o600 });
}

async function waitForRelease() {
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (existsSync(releasePath)) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject({ kind: 'cas-test-release-timeout' });
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

function waitForReleaseSync() {
  const deadline = Date.now() + 10_000;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw { kind: 'cas-test-release-timeout' };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

try {
  const api = await import(pathToFileURL(sourcePath).href);
  const options = { expectedRevision: revisionFor(target), mode: 0o600 };
  const operations = mode === 'async'
    ? {
        ...(crashPublish
          ? { beforeLockPublish: async () => { process.kill(process.pid, 'SIGKILL'); } }
          : {}),
        compare: async () => { signalCompare(); await waitForRelease(); },
      }
    : {
        ...(crashPublish
          ? { beforeLockPublish: () => { process.kill(process.pid, 'SIGKILL'); } }
          : {}),
        compare: () => { signalCompare(); waitForReleaseSync(); },
      };
  const result = mode === 'async'
    ? await api.confinedAtomicWriteFileForTest(target, Buffer.from(content), options, operations)
    : api.confinedAtomicWriteFileSyncForTest(target, Buffer.from(content), options, operations);
  writeFileSync(resultPath, JSON.stringify({ kind: result.kind }));
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ error: String(error) }));
  process.exitCode = 1;
}
`;

function waitForChild(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(fault(`CAS child exited with ${signal ?? code}: ${stderr}`));
      }
    });
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', () => resolvePromise());
  });
}

async function waitForReady(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (readFileSync(path, 'utf8').trim().length === 0) {
    if (Date.now() >= deadline) throw fault('CAS child did not reach compare');
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function readyCount(path: string): number {
  const content = readFileSync(path, 'utf8').trim();
  return content.length === 0 ? 0 : content.split('\n').length;
}

function casLockPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.cas.lock`);
}

function startCasChild(options: {
  mode: 'async' | 'sync';
  target: string;
  resultPath: string;
  readyPath: string;
  releasePath: string;
  content: string;
  crashPublish?: boolean;
}): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', concurrentChildScript],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SPLITBRIEF_CAS_MODE: options.mode,
        SPLITBRIEF_CAS_TARGET: options.target,
        SPLITBRIEF_CAS_RESULT: options.resultPath,
        SPLITBRIEF_CAS_READY: options.readyPath,
        SPLITBRIEF_CAS_RELEASE: options.releasePath,
        SPLITBRIEF_CAS_CONTENT: options.content,
        SPLITBRIEF_CAS_SOURCE: join(process.cwd(), 'src/lib/confined-fs-atomic.ts'),
        SPLITBRIEF_CAS_CRASH_PUBLISH: options.crashPublish === true ? '1' : '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
}

async function runExistingTargetRace(mode: 'async' | 'sync'): Promise<void> {
  const { dir, path } = makeFile('race base');
  const readyPath = join(dir, `${mode}.ready`);
  const releasePath = join(dir, `${mode}.release`);
  const resultPaths = [join(dir, `${mode}.one.result`), join(dir, `${mode}.two.result`)];
  writeFileSync(readyPath, '', { mode: 0o600 });
  const contents = ['race winner one', 'race winner two'];
  const children = contents.map((content, index) => {
    const resultPath = resultPaths[index];
    if (resultPath === undefined) throw fault('Missing CAS child result path');
    return startCasChild({
      mode,
      target: path,
      resultPath,
      readyPath,
      releasePath,
      content,
    });
  });

  try {
    await waitForReady(readyPath);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(readyCount(readyPath)).toBe(1);
    writeFileSync(releasePath, 'release', { mode: 0o600 });
    await Promise.all(children.map(waitForChild));
    const results = resultPaths.map((resultPath) => JSON.parse(readFileSync(resultPath, 'utf8')));
    expect(results.filter((result) => result.kind === 'written')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'conflict')).toHaveLength(1);
    expect(contents).toContain(readFileSync(path, 'utf8'));
  } finally {
    writeFileSync(releasePath, 'release', { mode: 0o600 });
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
}

async function runCrashRecoveryProbe(mode: 'async' | 'sync'): Promise<void> {
  const { dir, path, revision } = makeFile('crash base');
  const readyPath = join(dir, `${mode}.crash.ready`);
  const releasePath = join(dir, `${mode}.crash.release`);
  const resultPath = join(dir, `${mode}.crash.result`);
  writeFileSync(readyPath, '', { mode: 0o600 });
  const child = startCasChild({
    mode,
    target: path,
    resultPath,
    readyPath,
    releasePath,
    content: 'crashed writer',
  });

  try {
    await waitForReady(readyPath);
    child.kill('SIGKILL');
    await waitForChildExit(child);
    const result =
      mode === 'async'
        ? await confinedAtomicWriteFile(path, Buffer.from('recovered writer'), {
            expectedRevision: revision,
            mode: 0o600,
          })
        : confinedAtomicWriteFileSync(path, Buffer.from('recovered writer'), {
            expectedRevision: revision,
            mode: 0o600,
          });
    expect(result.kind).toBe('written');
    expect(readFileSync(path, 'utf8')).toBe('recovered writer');
    expect(existsSync(casLockPath(path))).toBe(false);
  } finally {
    writeFileSync(releasePath, 'release', { mode: 0o600 });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function runCrashDuringLockPublishProbe(mode: 'async' | 'sync'): Promise<void> {
  const { dir, path, revision } = makeFile('publish crash base');
  const child = startCasChild({
    mode,
    target: path,
    resultPath: join(dir, `${mode}.publish-crash.result`),
    readyPath: join(dir, `${mode}.publish-crash.ready`),
    releasePath: join(dir, `${mode}.publish-crash.release`),
    content: 'crashed before lock publication',
    crashPublish: true,
  });

  try {
    await waitForChildExit(child);
    expect(child.signalCode).toBe('SIGKILL');
    const result =
      mode === 'async'
        ? await confinedAtomicWriteFile(path, Buffer.from('recovered after publish crash'), {
            expectedRevision: revision,
            mode: 0o600,
          })
        : confinedAtomicWriteFileSync(path, Buffer.from('recovered after publish crash'), {
            expectedRevision: revision,
            mode: 0o600,
          });
    expect(result.kind).toBe('written');
    expect(readFileSync(path, 'utf8')).toBe('recovered after publish crash');
    expect(existsSync(casLockPath(path))).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function runLiveOwnerProbe(mode: 'async' | 'sync'): Promise<void> {
  const { dir, path } = makeFile('live owner base');
  const lockPath = casLockPath(path);
  const startTimeMs = readProcessStartTimeMs(process.pid);
  if (startTimeMs === null) throw fault('Current process start time unavailable');
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      startTimeMs: Math.floor(startTimeMs / 1000) * 1000,
      token: 'a'.repeat(32),
    }),
    { mode: 0o600 },
  );
  const readyPath = join(dir, `${mode}.live.ready`);
  const releasePath = join(dir, `${mode}.live.release`);
  const resultPath = join(dir, `${mode}.live.result`);
  writeFileSync(readyPath, '', { mode: 0o600 });
  const child = startCasChild({
    mode,
    target: path,
    resultPath,
    readyPath,
    releasePath,
    content: 'after live owner',
  });

  try {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(existsSync(resultPath)).toBe(false);
    expect(child.exitCode).toBeNull();
    unlinkSync(lockPath);
    writeFileSync(releasePath, 'release', { mode: 0o600 });
    await waitForChild(child);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({ kind: 'written' });
    expect(readFileSync(path, 'utf8')).toBe('after live owner');
  } finally {
    writeFileSync(releasePath, 'release', { mode: 0o600 });
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

function exitedProcessPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  const pid = Number(child.stdout);
  if (!Number.isInteger(pid) || pid <= 0) throw fault('Could not obtain an exited process pid');
  return pid;
}

describe('confinedAtomicWriteFile', () => {
  itUnix('reclaims a lock only after proving its owner process is dead', async () => {
    const { path, revision } = makeFile();
    writeFileSync(
      casLockPath(path),
      JSON.stringify({ pid: exitedProcessPid(), startTimeMs: 0, token: 'b'.repeat(32) }),
      { mode: 0o600 },
    );

    const result = await confinedAtomicWriteFile(path, Buffer.from('dead owner recovered'), {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result.kind).toBe('written');
    expect(readFileSync(path, 'utf8')).toBe('dead owner recovered');
    expect(existsSync(casLockPath(path))).toBe(false);
  });

  itUnix('serializes concurrent existing-target CAS writers', async () => {
    await runExistingTargetRace('async');
  });

  itUnix('recovers a lock left by a crashed existing-target writer', async () => {
    await runCrashRecoveryProbe('async');
  });

  itUnix('recovers after a crash before publishing the complete lock owner', async () => {
    await runCrashDuringLockPublishProbe('async');
  });

  itUnix('does not reclaim a lock owned by a live process', async () => {
    await runLiveOwnerProbe('async');
  });

  itUnix('does not remove a successor during stale unlock', async () => {
    const { path, revision } = makeFile();
    const successor = JSON.stringify({
      pid: exitedProcessPid(),
      startTimeMs: 0,
      token: 'd'.repeat(32),
    });
    let replaced = false;
    let writeStarted = false;
    const operations: ConfinedAtomicWriteTestOperations = {
      compare: async () => {
        writeStarted = true;
      },
      beforeLockMove: (lockPath) => {
        if (!writeStarted || replaced) return;
        replaced = true;
        unlinkSync(lockPath);
        writeFileSync(lockPath, successor, { mode: 0o600 });
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      Buffer.from('successor-safe async'),
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('written');
    expect(readFileSync(casLockPath(path), 'utf8')).toBe(successor);
  });

  itUnix('rejects a symlinked CAS lock without following it', async () => {
    const { path, revision } = makeFile();
    const externalLock = join(dirname(path), 'external-cas-lock');
    writeFileSync(externalLock, 'external lock', { mode: 0o600 });
    symlinkSync(externalLock, casLockPath(path));

    await expect(
      confinedAtomicWriteFile(path, Buffer.from('must not publish'), {
        expectedRevision: revision,
        mode: 0o600,
      }),
    ).rejects.toMatchObject({ kind: 'fs-symlink-write' });
    expect(readFileSync(externalLock, 'utf8')).toBe('external lock');
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
  });

  itUnix('fails closed on an incomplete CAS lock owner', async () => {
    const { path, revision } = makeFile();
    writeFileSync(casLockPath(path), '', { mode: 0o600 });

    await expect(
      confinedAtomicWriteFile(path, Buffer.from('must not publish'), {
        expectedRevision: revision,
        mode: 0o600,
      }),
    ).rejects.toMatchObject({ kind: 'fs-invalid-id' });
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
  });

  it('replaces a canonical target with the complete bytes and its observed revision', async () => {
    const { dir, revision } = makeFile();
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    const path = join(nested, '..', 'config.yaml');
    const replacement = Buffer.from('new \u{1f680} bytes '.repeat(20_000));

    const result = await confinedAtomicWriteFile(path, replacement, {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result.kind).toBe('written');
    expect(readFileSync(join(dir, 'config.yaml'))).toEqual(replacement);
    if (result.kind === 'written') {
      expect(result.revision).toEqual(revisionFor(join(dir, 'config.yaml')));
    }
    expect(temporaryFiles(dir)).toEqual([]);
  });

  itUnix(
    'keeps the final regular target owner-only even when the prior file was wider',
    async () => {
      const { path } = makeFile();
      chmodSync(path, 0o644);
      const widenedRevision = revisionFor(path);

      const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
        expectedRevision: widenedRevision,
        mode: 0o600,
      });

      expect(result.kind).toBe('written');
      expect(statSync(path).isFile()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it('returns a conflict without replacing bytes changed since the expected revision', async () => {
    const { dir, path, revision } = makeFile();
    writeFileSync(path, 'external update');

    const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('external update');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns a conflict when matching bytes have a different file identity', async () => {
    const { dir, path, revision } = makeFile();
    const future = new Date(Date.now() + 10_000);
    utimesSync(path, future, future);

    const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('creates a missing target only when absence was the expected revision', async () => {
    const dir = createAtomicTempDir('confined-atomic-first-save');
    const path = join(dir, 'config.yaml');
    const replacement = Buffer.from('version: 3\n');

    const result = await confinedAtomicWriteFile(path, replacement, {
      expectedRevision: null,
      mode: 0o600,
    });

    expect(result.kind).toBe('written');
    expect(readFileSync(path)).toEqual(replacement);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns a conflict when absence was expected but the target exists', async () => {
    const { dir, path } = makeFile();

    const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
      expectedRevision: null,
      mode: 0o600,
    });

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns a conflict when another creator wins the first-save publish race', async () => {
    const dir = createAtomicTempDir('confined-atomic-create-race');
    const path = join(dir, 'config.yaml');
    const operations: ConfinedAtomicWriteTestOperations = {
      link: async (from, to) => {
        writeFileSync(to, 'racing creator', { mode: 0o600 });
        await link(from, to);
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      Buffer.from('replacement'),
      { expectedRevision: null, mode: 0o600 },
      operations,
    );

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('racing creator');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  itUnix('rejects a symlink target without following or changing the linked file', async () => {
    const { dir, path, revision } = makeFile();
    const linkedTarget = join(dir, 'linked-target.yaml');
    writeFileSync(linkedTarget, 'linked original');
    const link = join(dir, 'config-link.yaml');
    symlinkSync(linkedTarget, link);

    await expect(
      confinedAtomicWriteFile(link, Buffer.from('replacement'), {
        expectedRevision: revision,
        mode: 0o600,
      }),
    ).rejects.toMatchObject({ kind: 'fs-symlink-write' });
    expect(readFileSync(linkedTarget, 'utf8')).toBe('linked original');
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
  });

  itUnix('never treats a dangling symlink as expected absence', async () => {
    const dir = createAtomicTempDir('confined-atomic-dangling-link');
    const missingTarget = join(dir, 'missing.yaml');
    const linkPath = join(dir, 'config.yaml');
    symlinkSync(missingTarget, linkPath);

    await expect(
      confinedAtomicWriteFile(linkPath, Buffer.from('replacement'), {
        expectedRevision: null,
        mode: 0o600,
      }),
    ).rejects.toMatchObject({ kind: 'fs-symlink-write' });
    expect(existsSync(missingTarget)).toBe(false);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  itUnix(
    'rejects a symlinked parent without changing the external target or creating a temp file',
    async () => {
      const project = createAtomicTempDir('confined-atomic-project');
      const outside = createAtomicTempDir('confined-atomic-outside');
      const parent = join(project, '.splitbrief');
      const externalTarget = join(outside, 'config.yaml');
      writeFileSync(externalTarget, 'outside original');
      symlinkSync(outside, parent);

      await expect(
        confinedAtomicWriteFile(join(parent, 'config.yaml'), Buffer.from('escaped replacement'), {
          expectedRevision: revisionFor(externalTarget),
          mode: 0o600,
        }),
      ).rejects.toMatchObject({ kind: 'fs-symlink-write' });

      expect(readFileSync(externalTarget, 'utf8')).toBe('outside original');
      expect(temporaryFiles(project)).toEqual([]);
      expect(temporaryFiles(outside)).toEqual([]);
    },
  );

  it('opens target and temporary files with no-follow protection, and creates the temp exclusively', async () => {
    const { dir, path, revision } = makeFile();
    const opened: Array<Readonly<{ path: string; flags: number }>> = [];
    const operations: ConfinedAtomicWriteTestOperations = {
      open: async (openPath, flags, mode) => {
        opened.push({ path: openPath, flags });
        return open(openPath, flags, mode);
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      Buffer.from('replacement'),
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('written');
    const targetOpens = opened.filter((entry) => entry.path === path);
    const temporary = opened.find((entry) => entry.path.includes('.tmp.'));
    expect(targetOpens.some((entry) => (entry.flags & constants.O_NOFOLLOW) !== 0)).toBe(true);
    expect(temporary).toBeDefined();
    if (!temporary) throw new Error('Expected the atomic temporary file to be opened');
    expect(temporary.flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(temporary.flags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it.each(['open', 'write', 'fsync', 'chmod', 'read', 'stat', 'compare', 'rename'] as const)(
    'preserves the original bytes when %s fails before rename',
    async (operation) => {
      const { dir, path, revision } = makeFile();

      await expect(
        confinedAtomicWriteFileForTest(
          path,
          Buffer.from('replacement'),
          { expectedRevision: revision, mode: 0o600 },
          faultingOperations(operation),
        ),
      ).rejects.toThrow(`${operation === 'chmod' ? 'temporary mode' : operation} failed`);

      expect(readFileSync(path, 'utf8')).toBe('original bytes');
      expect(temporaryFiles(dir)).toEqual([]);
    },
  );

  it('preserves absence when a first-save link fails', async () => {
    const dir = createAtomicTempDir('confined-atomic-link-failure');
    const path = join(dir, 'config.yaml');

    await expect(
      confinedAtomicWriteFileForTest(
        path,
        Buffer.from('replacement'),
        { expectedRevision: null, mode: 0o600 },
        faultingOperations('link'),
      ),
    ).rejects.toThrow('link failed');
    expect(existsSync(path)).toBe(false);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('reports durability uncertainty after a successful replacement whose directory sync fails', async () => {
    const { path, revision } = makeFile();
    const replacement = Buffer.from('replacement that is already visible');
    const operations: ConfinedAtomicWriteTestOperations = {
      fsync: async (handle, target) => {
        if (target === 'directory') throw fault('directory fsync failed');
        await handle.sync();
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      replacement,
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('durability-uncertain');
    expect(readFileSync(path)).toEqual(replacement);
    if (result.kind === 'durability-uncertain') {
      expect(result.observedRevision).toEqual(revisionFor(path));
      expect(result.observedRevision.rawSha256).toBe(
        createHash('sha256').update(replacement).digest('hex'),
      );
    }
  });

  it('reports durability uncertainty when the final read fails after rename', async () => {
    const { path, revision } = makeFile();
    let targetOpens = 0;
    let finalTargetRead = false;
    const operations: ConfinedAtomicWriteTestOperations = {
      open: async (openPath, flags, mode) => {
        const handle = await open(openPath, flags, mode);
        if (openPath === path) {
          targetOpens += 1;
          finalTargetRead = targetOpens === 2;
        }
        return handle;
      },
      read: async (handle, bytes, offset, length, position) => {
        if (finalTargetRead) throw fault('final read failed');
        const result = await handle.read(bytes, offset, length, position);
        return { bytesRead: result.bytesRead };
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      Buffer.from('replacement'),
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('durability-uncertain');
    expect(readFileSync(path, 'utf8')).toBe('replacement');
  });

  itUnix('rejects a parent replacement without unlinking through a new symlink', async () => {
    const { dir, path, revision } = makeFile();
    const moved = `${dir}.moved`;
    const outside = createAtomicTempDir('confined-atomic-parent-swap-outside');
    tmpDirs.push(moved);
    let temporaryPath: string | undefined;
    const operations: ConfinedAtomicWriteTestOperations = {
      open: async (openPath, flags, mode) => {
        temporaryPath = openPath.includes('.tmp.') ? openPath : temporaryPath;
        return open(openPath, flags, mode);
      },
      compare: () => {
        renameSync(dir, moved);
        symlinkSync(outside, dir);
        if (temporaryPath === undefined) throw new Error('Expected a temporary path');
        writeFileSync(join(outside, basename(temporaryPath)), 'outside sentinel');
      },
    };

    await expect(
      confinedAtomicWriteFileForTest(
        path,
        Buffer.from('replacement'),
        { expectedRevision: revision, mode: 0o600 },
        operations,
      ),
    ).rejects.toMatchObject({ kind: 'fs-symlink-write' });
    expect(readFileSync(join(moved, 'config.yaml'), 'utf8')).toBe('original bytes');
    expect(readFileSync(join(outside, basename(temporaryPath ?? 'missing')), 'utf8')).toBe(
      'outside sentinel',
    );
  });

  it('writes every byte when the filesystem accepts partial writes', async () => {
    const { path, revision } = makeFile();
    const replacement = Buffer.from('partial-write-safe '.repeat(10_000));
    const operations: ConfinedAtomicWriteTestOperations = {
      write: async (handle, bytes, offset, length, position) => {
        const result = await handle.write(bytes, offset, Math.min(length, 17), position);
        return { bytesWritten: result.bytesWritten };
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      replacement,
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('written');
    expect(readFileSync(path)).toEqual(replacement);
  });

  it('does not create a target before a failed replacement can be committed', async () => {
    const dir = createAtomicTempDir('confined-atomic-missing');
    const path = join(dir, 'absent.yaml');
    const expectedRevision: ConfigRevision = {
      rawSha256: '0'.repeat(64),
      fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
    };

    const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
      expectedRevision,
      mode: 0o600,
    });

    expect(result).toEqual({ kind: 'conflict', observedRevision: null });
    expect(existsSync(path)).toBe(false);
    expect(temporaryFiles(dir)).toEqual([]);
  });
});

describe('confinedAtomicWriteFileSync', () => {
  itUnix('reclaims a lock only after proving its owner process is dead', () => {
    const { path, revision } = makeFile();
    writeFileSync(
      casLockPath(path),
      JSON.stringify({ pid: exitedProcessPid(), startTimeMs: 0, token: 'c'.repeat(32) }),
      { mode: 0o600 },
    );

    const result = confinedAtomicWriteFileSync(path, Buffer.from('sync dead owner recovered'), {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result.kind).toBe('written');
    expect(readFileSync(path, 'utf8')).toBe('sync dead owner recovered');
    expect(existsSync(casLockPath(path))).toBe(false);
  });

  itUnix('serializes concurrent existing-target CAS writers', async () => {
    await runExistingTargetRace('sync');
  });

  itUnix('recovers a lock left by a crashed existing-target writer', async () => {
    await runCrashRecoveryProbe('sync');
  });

  itUnix('recovers after a crash before publishing the complete lock owner', async () => {
    await runCrashDuringLockPublishProbe('sync');
  });

  itUnix('does not reclaim a lock owned by a live process', async () => {
    await runLiveOwnerProbe('sync');
  });

  itUnix('does not remove a successor during stale unlock', () => {
    const { path, revision } = makeFile();
    const successor = JSON.stringify({
      pid: exitedProcessPid(),
      startTimeMs: 0,
      token: 'e'.repeat(32),
    });
    let replaced = false;
    let writeStarted = false;
    const operations: ConfinedAtomicWriteSyncTestOperations = {
      compare: () => {
        writeStarted = true;
      },
      beforeLockMove: (lockPath) => {
        if (!writeStarted || replaced) return;
        replaced = true;
        unlinkSync(lockPath);
        writeFileSync(lockPath, successor, { mode: 0o600 });
      },
    };

    const result = confinedAtomicWriteFileSyncForTest(
      path,
      Buffer.from('successor-safe sync'),
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('written');
    expect(readFileSync(casLockPath(path), 'utf8')).toBe(successor);
  });

  itUnix('rejects a symlinked CAS lock without following it', () => {
    const { path, revision } = makeFile();
    const externalLock = join(dirname(path), 'external-cas-lock');
    writeFileSync(externalLock, 'external sync lock', { mode: 0o600 });
    symlinkSync(externalLock, casLockPath(path));

    expect(() =>
      confinedAtomicWriteFileSync(path, Buffer.from('must not publish'), {
        expectedRevision: revision,
        mode: 0o600,
      }),
    ).toThrow(expect.objectContaining({ kind: 'fs-symlink-write' }));
    expect(readFileSync(externalLock, 'utf8')).toBe('external sync lock');
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
  });

  itUnix('fails closed on an incomplete CAS lock owner', () => {
    const { path, revision } = makeFile();
    writeFileSync(casLockPath(path), '', { mode: 0o600 });

    expect(() =>
      confinedAtomicWriteFileSync(path, Buffer.from('must not publish'), {
        expectedRevision: revision,
        mode: 0o600,
      }),
    ).toThrow(expect.objectContaining({ kind: 'fs-invalid-id' }));
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
  });

  it('replaces a canonical target with complete bytes and an owner-only mode', () => {
    const { dir, path, revision } = makeFile();
    const replacement = Buffer.from('sync replacement '.repeat(20_000));

    const result = confinedAtomicWriteFileSync(path, replacement, {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result.kind).toBe('written');
    expect(readFileSync(path)).toEqual(replacement);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    if (result.kind === 'written') expect(result.revision).toEqual(revisionFor(path));
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns a conflict without replacing changed bytes', () => {
    const { dir, path, revision } = makeFile();
    writeFileSync(path, 'sync external update');

    const result = confinedAtomicWriteFileSync(path, Buffer.from('replacement'), {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('sync external update');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('creates a missing target only when absence was expected', () => {
    const dir = createAtomicTempDir('confined-atomic-sync-first-save');
    const path = join(dir, 'config.yaml');

    const result = confinedAtomicWriteFileSync(path, Buffer.from('version: 3\n'), {
      expectedRevision: null,
      mode: 0o600,
    });

    expect(result.kind).toBe('written');
    expect(readFileSync(path, 'utf8')).toBe('version: 3\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns a conflict when another creator wins the first-save race', () => {
    const dir = createAtomicTempDir('confined-atomic-sync-create-race');
    const path = join(dir, 'config.yaml');
    const operations: ConfinedAtomicWriteSyncTestOperations = {
      link: (from, to) => {
        writeFileSync(to, 'sync racing creator', { mode: 0o600 });
        linkSync(from, to);
      },
    };

    const result = confinedAtomicWriteFileSyncForTest(
      path,
      Buffer.from('replacement'),
      { expectedRevision: null, mode: 0o600 },
      operations,
    );

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('sync racing creator');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  itUnix('rejects a symlink target without changing the linked file', () => {
    const { dir, path, revision } = makeFile();
    const linkedTarget = join(dir, 'linked-target.yaml');
    writeFileSync(linkedTarget, 'linked original');
    const linkPath = join(dir, 'config-link.yaml');
    symlinkSync(linkedTarget, linkPath);

    expect(() =>
      confinedAtomicWriteFileSync(linkPath, Buffer.from('replacement'), {
        expectedRevision: revision,
        mode: 0o600,
      }),
    ).toThrow(expect.objectContaining({ kind: 'fs-symlink-write' }));
    expect(readFileSync(linkedTarget, 'utf8')).toBe('linked original');
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
  });

  itUnix('rejects a symlinked parent without changing the external target', () => {
    const project = createAtomicTempDir('confined-atomic-sync-project');
    const outside = createAtomicTempDir('confined-atomic-sync-outside');
    const parent = join(project, '.splitbrief');
    const externalTarget = join(outside, 'config.yaml');
    writeFileSync(externalTarget, 'outside original');
    symlinkSync(outside, parent);

    expect(() =>
      confinedAtomicWriteFileSync(join(parent, 'config.yaml'), Buffer.from('escaped'), {
        expectedRevision: revisionFor(externalTarget),
        mode: 0o600,
      }),
    ).toThrow(expect.objectContaining({ kind: 'fs-symlink-write' }));
    expect(readFileSync(externalTarget, 'utf8')).toBe('outside original');
    expect(temporaryFiles(project)).toEqual([]);
    expect(temporaryFiles(outside)).toEqual([]);
  });

  it.each(['open', 'write', 'fsync', 'read', 'stat', 'compare', 'rename'] as const)(
    'preserves the original bytes when %s fails before publish',
    (operation) => {
      const { dir, path, revision } = makeFile();

      expect(() =>
        confinedAtomicWriteFileSyncForTest(
          path,
          Buffer.from('replacement'),
          { expectedRevision: revision, mode: 0o600 },
          faultingSyncOperations(operation),
        ),
      ).toThrow(`${operation === 'stat' ? 'pre-rename fstat' : operation} failed`);
      expect(readFileSync(path, 'utf8')).toBe('original bytes');
      expect(temporaryFiles(dir)).toEqual([]);
    },
  );

  it('preserves absence when a first-save link fails', () => {
    const dir = createAtomicTempDir('confined-atomic-sync-link-failure');
    const path = join(dir, 'config.yaml');

    expect(() =>
      confinedAtomicWriteFileSyncForTest(
        path,
        Buffer.from('replacement'),
        { expectedRevision: null, mode: 0o600 },
        faultingSyncOperations('link'),
      ),
    ).toThrow('link failed');
    expect(existsSync(path)).toBe(false);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns durability uncertainty when the final read fails after publish', () => {
    const { path, revision } = makeFile();
    let targetOpens = 0;
    let finalTargetRead = false;
    const operations: ConfinedAtomicWriteSyncTestOperations = {
      open: (openPath, flags, mode) => {
        const handle =
          mode === undefined ? openSync(openPath, flags) : openSync(openPath, flags, mode);
        if (openPath === path) {
          targetOpens += 1;
          finalTargetRead = targetOpens === 2;
        }
        return handle;
      },
      read: (handle, bytes, offset, length, position) => {
        if (finalTargetRead) throw fault('final read failed');
        return readSync(handle, bytes, offset, length, position);
      },
    };

    const result = confinedAtomicWriteFileSyncForTest(
      path,
      Buffer.from('replacement'),
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('durability-uncertain');
    expect(readFileSync(path, 'utf8')).toBe('replacement');
  });

  it('returns durability uncertainty when directory fsync fails', () => {
    const { path, revision } = makeFile();
    const replacement = Buffer.from('replacement after directory fsync');
    const operations: ConfinedAtomicWriteSyncTestOperations = {
      fsync: (handle, target) => {
        if (target === 'directory') throw fault('directory fsync failed');
        fsyncSync(handle);
      },
    };

    const result = confinedAtomicWriteFileSyncForTest(
      path,
      replacement,
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('durability-uncertain');
    expect(readFileSync(path)).toEqual(replacement);
  });

  it('writes every byte when the filesystem accepts partial writes', () => {
    const { path, revision } = makeFile();
    const replacement = Buffer.from('partial-write-safe '.repeat(10_000));
    const operations: ConfinedAtomicWriteSyncTestOperations = {
      write: (handle, bytes, offset, length, position) =>
        writeSync(handle, bytes, offset, Math.min(length, 17), position),
    };

    const result = confinedAtomicWriteFileSyncForTest(
      path,
      replacement,
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('written');
    expect(readFileSync(path)).toEqual(replacement);
  });

  itUnix('rejects a parent replacement before publishing a temporary file', () => {
    const { dir, path, revision } = makeFile();
    const moved = `${dir}.moved`;
    const outside = createAtomicTempDir('confined-atomic-sync-parent-swap-outside');
    tmpDirs.push(moved);
    let temporaryPath: string | undefined;
    const operations: ConfinedAtomicWriteSyncTestOperations = {
      open: (openPath, flags, mode) => {
        temporaryPath = openPath.includes('.tmp.') ? openPath : temporaryPath;
        return mode === undefined ? openSync(openPath, flags) : openSync(openPath, flags, mode);
      },
      compare: () => {
        renameSync(dir, moved);
        symlinkSync(outside, dir);
        if (temporaryPath === undefined) throw new Error('Expected a temporary path');
        writeFileSync(join(outside, basename(temporaryPath)), 'outside sentinel');
      },
    };

    expect(() =>
      confinedAtomicWriteFileSyncForTest(
        path,
        Buffer.from('replacement'),
        { expectedRevision: revision, mode: 0o600 },
        operations,
      ),
    ).toThrow(
      expect.objectContaining({ kind: expect.stringMatching(/^fs-(symlink-write|invalid-id)$/) }),
    );
    expect(readFileSync(join(moved, 'config.yaml'), 'utf8')).toBe('original bytes');
    expect(readFileSync(join(outside, basename(temporaryPath ?? 'missing')), 'utf8')).toBe(
      'outside sentinel',
    );
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { packageScript, readPackageJson } from './project-meta.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

// The probe substitutes what openSync really opens at the descriptor boundary: the path can stay a
// regular package.json while the descriptor is a FIFO. readFds/closedFds pin down where the read
// begins and that every failing path still releases the descriptor.
const fsProbe = vi.hoisted(() => ({
  substituteAtOpen: '',
  failRead: undefined as Error | undefined,
  openTargets: [] as string[],
  readFds: [] as number[],
  closedFds: [] as number[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: unknown[]) => {
      const path = args[0];
      const substitutesPath =
        fsProbe.substituteAtOpen !== '' &&
        typeof path === 'string' &&
        path.endsWith('package.json');
      const target = substitutesPath ? fsProbe.substituteAtOpen : path;
      if (substitutesPath) {
        // Keep the substituted FIFO nonblocking so a regressed open cannot stall the worker.
        args[1] = Number(args[1]) | actual.constants.O_NONBLOCK;
      }
      fsProbe.openTargets.push(String(target));
      return (actual.openSync as (...a: unknown[]) => unknown)(target, ...args.slice(1));
    },
    readFileSync: (...args: unknown[]) => {
      const file = args[0];
      if (typeof file === 'number') {
        fsProbe.readFds.push(file);
        if (fsProbe.failRead !== undefined) throw fsProbe.failRead;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    },
    closeSync: (fd: unknown) => {
      fsProbe.closedFds.push(Number(fd));
      return (actual.closeSync as (...a: unknown[]) => unknown)(fd);
    },
  };
});

// A FIFO read with no writer blocks the process, so the probe runs in a child the spawn timeout
// can stop: the default call must finish bounded and return null, the flagged call must error.
const fifoProbeScript = `
const { readPackageJson } = await import(process.env.PROJECT_META_MODULE);
const dir = process.env.PROJECT_META_DIR;
const plain = readPackageJson(dir);
let flagged;
try {
  readPackageJson(dir, { throwOnInvalid: true });
  flagged = { threw: false };
} catch (err) {
  flagged = { threw: true, name: err.name, kind: err.kind, message: err.message };
}
process.stdout.write(JSON.stringify({ plain, flagged }));
`;

describe('packageScript', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('project-meta');
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  function writePackageJson(pkg: Record<string, unknown>): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  }

  it('returns the script body verbatim', () => {
    writePackageJson({ scripts: { lint: 'biome check .' } });
    expect(packageScript(dir, 'lint')).toBe('biome check .');
  });

  it('returns null without a package.json', () => {
    expect(packageScript(dir, 'test')).toBeNull();
  });

  it('returns null when scripts is absent or not an object', () => {
    writePackageJson({ name: 'x' });
    expect(packageScript(dir, 'test')).toBeNull();
    writePackageJson({ scripts: 'vitest run' });
    expect(packageScript(dir, 'test')).toBeNull();
  });

  it('returns null for a missing, non-string or blank script', () => {
    writePackageJson({ scripts: { build: 'tsc' } });
    expect(packageScript(dir, 'test')).toBeNull();
    writePackageJson({ scripts: { test: 42 } });
    expect(packageScript(dir, 'test')).toBeNull();
    writePackageJson({ scripts: { test: '   ' } });
    expect(packageScript(dir, 'test')).toBeNull();
  });
});

describe('readPackageJson', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('project-meta');
  });
  afterEach(() => {
    fsProbe.substituteAtOpen = '';
    fsProbe.failRead = undefined;
    cleanupTempDir(dir);
  });

  it('returns the parsed record for valid JSON with and without throwOnInvalid', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', private: true }));
    expect(readPackageJson(dir)).toEqual({ name: 'demo', private: true });
    expect(readPackageJson(dir, { throwOnInvalid: true })).toEqual({ name: 'demo', private: true });
  });

  it('returns null for malformed JSON and throws only when throwOnInvalid is set', () => {
    writeFileSync(join(dir, 'package.json'), '{ "name": ');
    expect(readPackageJson(dir)).toBeNull();
    expect(() => readPackageJson(dir, { throwOnInvalid: true })).toThrow(SyntaxError);
  });

  it('returns null for valid nonobject JSON even when throwOnInvalid is set', () => {
    for (const body of ['[]', '42', '"text"', 'null']) {
      writeFileSync(join(dir, 'package.json'), body);
      expect(readPackageJson(dir)).toBeNull();
      expect(readPackageJson(dir, { throwOnInvalid: true })).toBeNull();
    }
  });

  it('returns null for a missing package.json even when throwOnInvalid is set', () => {
    expect(readPackageJson(dir)).toBeNull();
    expect(readPackageJson(dir, { throwOnInvalid: true })).toBeNull();
  });

  it('follows a symlink to a regular package.json', () => {
    const realPath = join(dir, 'linked.json');
    writeFileSync(realPath, JSON.stringify({ name: 'linked' }));
    symlinkSync(realPath, join(dir, 'package.json'));

    expect(readPackageJson(dir)).toEqual({ name: 'linked' });
    expect(readPackageJson(dir, { throwOnInvalid: true })).toEqual({ name: 'linked' });
  });

  itUnix('does not stall on a package.json FIFO with no writer (throwOnInvalid errors)', () => {
    execFileSync('mkfifo', [join(dir, 'package.json')]);

    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '-e', fifoProbeScript],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PROJECT_META_DIR: dir,
          PROJECT_META_MODULE: new URL('./project-meta.ts', import.meta.url).href,
        },
        timeout: 20_000,
      },
    );

    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout) as {
      plain: unknown;
      flagged: { threw: boolean; name?: string; kind?: string; message?: string };
    };
    expect(result.plain).toBeNull();
    expect(result.flagged.threw).toBe(true);
    expect(result.flagged.name).toBe('Error');
    expect(result.flagged.kind).toBe('package-json-not-regular');
    expect(result.flagged.message).toContain('package.json is not a regular file');
  });

  itUnix('refuses the read when the opened descriptor is a FIFO behind a regular path', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'regular' }));
    const fifoPath = join(dir, 'substituted.fifo');
    execFileSync('mkfifo', [fifoPath]);

    const readsBefore = fsProbe.readFds.length;
    const closesBefore = fsProbe.closedFds.length;
    fsProbe.substituteAtOpen = fifoPath;
    try {
      expect(readPackageJson(dir)).toBeNull();
    } finally {
      fsProbe.substituteAtOpen = '';
    }

    expect(fsProbe.openTargets.at(-1)).toBe(fifoPath);
    expect(fsProbe.readFds.length).toBe(readsBefore); // the read never begins
    expect(fsProbe.closedFds.length).toBe(closesBefore + 1); // the descriptor still closes
  });

  it('closes the descriptor after read and parse failures', () => {
    writeFileSync(join(dir, 'package.json'), '{ "name": ');
    const parseReads = fsProbe.readFds.length;
    const parseCloses = fsProbe.closedFds.length;
    expect(() => readPackageJson(dir, { throwOnInvalid: true })).toThrow(SyntaxError);
    expect(fsProbe.readFds.length).toBe(parseReads + 1);
    expect(fsProbe.closedFds.length).toBe(parseCloses + 1);
    expect(fsProbe.closedFds.at(-1)).toBe(fsProbe.readFds.at(-1));

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    fsProbe.failRead = new Error('EIO: simulated read failure');
    const ioReads = fsProbe.readFds.length;
    const ioCloses = fsProbe.closedFds.length;
    try {
      expect(readPackageJson(dir)).toBeNull();
      expect(() => readPackageJson(dir, { throwOnInvalid: true })).toThrow(
        /simulated read failure/,
      );
    } finally {
      fsProbe.failRead = undefined;
    }
    expect(fsProbe.readFds.length).toBe(ioReads + 2);
    expect(fsProbe.closedFds.length).toBe(ioCloses + 2);
    expect(fsProbe.closedFds.at(-1)).toBe(fsProbe.readFds.at(-1));
  });
});

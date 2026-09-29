import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashHooksConfig } from './trust-digest.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const originalScript = 'export default () => ({ kind: "allow" });\n';
const foreignScript = 'export default () => ({ kind: "deny" });\n';
const scriptHookConfig = { pre_task: [{ command: 'node', args: ['./check.mjs'] }] };

// The `node:fs` mock swaps the hook script between the production lstat and the production open,
// leaving unrelated fs calls untouched. Production must see genuine regular-file stats, then
// refuse or close whatever the path became before any descriptor read.
const fsControl = vi.hoisted(() => ({
  replacePath: null as string | null,
  replacementPath: null as string | null,
  swapAtLstat: false,
  lstatSawRegularFile: false,
  openPaths: [] as string[],
  openedFds: [] as number[],
  closedFds: [] as number[],
  descriptorReads: [] as number[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // The replacement is installed at the seam a test selects: after lstat for the path-read proof,
  // or inside open for the descriptor-side checks.
  const swapInReplacement = (path: string): void => {
    const replacement = fsControl.replacementPath;
    if (path === fsControl.replacePath && replacement !== null) {
      actual.renameSync(replacement, path);
      fsControl.replacementPath = null;
    }
  };
  return {
    ...actual,
    lstatSync(path: string, options?: unknown) {
      const stats = actual.lstatSync(path, options as never);
      if (path === fsControl.replacePath && stats.isFile()) {
        fsControl.lstatSawRegularFile = true;
        if (fsControl.swapAtLstat) swapInReplacement(path);
      }
      return stats;
    },
    openSync(path: string, flags: number, mode?: unknown) {
      swapInReplacement(path);
      fsControl.openPaths.push(path);
      // A FIFO read waits for a writer that may never come, so every open is forced non-blocking:
      // the substituted FIFO cannot wedge this worker, and even a regressed read of an empty FIFO
      // returns at once instead of blocking.
      const fd = actual.openSync(path, flags | (actual.constants.O_NONBLOCK ?? 0), mode as never);
      fsControl.openedFds.push(fd);
      return fd;
    },
    readFileSync(file: unknown, options?: unknown) {
      if (typeof file === 'number') fsControl.descriptorReads.push(file);
      if (options === undefined) return actual.readFileSync(file as string | number);
      return actual.readFileSync(file as string | number, options as never);
    },
    closeSync(fd: number) {
      fsControl.closedFds.push(fd);
      return actual.closeSync(fd);
    },
  };
});

// A read of a FIFO that no writer opens blocks the whole process, so the digest runs in a child
// that the spawn timeout can stop.
const hashFifoHookScript = `
const { hashHooksConfig } = await import(process.env.DIGEST_MODULE);
const hooks = { pre_task: [{ command: 'node', args: ['./check.mjs'] }] };
process.stdout.write(hashHooksConfig(process.env.PROJECT_DIR, hooks));
`;

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-trust-digest-'));
  resetFsControl();
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function resetFsControl(): void {
  fsControl.replacePath = null;
  fsControl.replacementPath = null;
  fsControl.swapAtLstat = false;
  fsControl.lstatSawRegularFile = false;
  fsControl.openPaths.length = 0;
  fsControl.openedFds.length = 0;
  fsControl.closedFds.length = 0;
  fsControl.descriptorReads.length = 0;
}

function writeHookScript(content: string): string {
  const scriptPath = join(projectDir, 'check.mjs');
  writeFileSync(scriptPath, content);
  return scriptPath;
}

describe('hashHooksConfig', () => {
  it('is canonical — key order does not affect hash', () => {
    const a = hashHooksConfig(projectDir, {
      pre_task: [{ command: 'x' }],
      post_task: [{ command: 'y' }],
    });
    const b = hashHooksConfig(projectDir, {
      post_task: [{ command: 'y' }],
      pre_task: [{ command: 'x' }],
    });
    expect(a).toBe(b);
  });

  it('changes when an interpreter-launched command hook script changes', () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    writeFileSync(
      join(projectDir, 'hooks', 'check.mjs'),
      'export default () => ({ kind: "allow" });',
    );
    const cfg = { pre_task: [{ command: 'node', args: ['hooks/check.mjs'] }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(
      join(projectDir, 'hooks', 'check.mjs'),
      'export default () => ({ kind: "deny" });',
    );

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  it('hashes an absolute repo-local executable and changes when only it changes', () => {
    const executable = join(projectDir, 'nodemon');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    writeFileSync(join(projectDir, 'check.mjs'), 'export default () => ({ kind: "allow" });\n');
    const cfg = { pre_task: [{ command: executable, args: ['check.mjs'] }] };
    resetFsControl();
    const before = hashHooksConfig(projectDir, cfg);
    const openPaths = [...fsControl.openPaths];

    writeFileSync(executable, '#!/bin/sh\nexit 1\n');

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
    // The absolute spelling must take the same confined descriptor read as the relative one:
    // a confinement error would leave the executable's bytes outside the digest.
    expect(openPaths).toContain(executable);
  });

  it('hashes an absolute repo-local script operand through its repo-relative path', () => {
    const script = join(projectDir, 'check.mjs');
    writeFileSync(script, 'export default () => ({ kind: "allow" });\n');
    const cfg = { pre_task: [{ command: 'node', args: [script] }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(script, 'export default () => ({ kind: "deny" });\n');

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  itUnix('hashes the executable a symlinked-directory `..` path actually runs', () => {
    mkdirSync(join(projectDir, 'other', 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'nodemon'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(projectDir, 'other', 'nodemon'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(projectDir, 'check.mjs'), 'export default () => ({ kind: "allow" });\n');
    symlinkSync(join('other', 'subdir'), join(projectDir, 'link'));
    const cfg = { pre_task: [{ command: `${projectDir}/link/../nodemon`, args: ['check.mjs'] }] };
    const before = hashHooksConfig(projectDir, cfg);

    // The kernel walks `link` before collapsing `..`, so this command runs
    // `<projectDir>/other/nodemon`, not the `<projectDir>/nodemon` the lexical collapse names.
    writeFileSync(join(projectDir, 'other', 'nodemon'), '#!/bin/sh\nexit 1\n');
    const afterExecutedChange = hashHooksConfig(projectDir, cfg);

    expect(afterExecutedChange).not.toBe(before);

    // The file the lexical collapse names is not the executable, so its bytes stay out of trust.
    writeFileSync(join(projectDir, 'nodemon'), '#!/bin/sh\nexit 2\n');
    expect(hashHooksConfig(projectDir, cfg)).toBe(afterExecutedChange);
  });

  itUnix('hashes the executable a relative symlinked-directory `..` path actually runs', () => {
    mkdirSync(join(projectDir, 'other', 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'nodemon'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(projectDir, 'other', 'nodemon'), '#!/bin/sh\nexit 0\n');
    symlinkSync(join('other', 'subdir'), join(projectDir, 'link'));
    const cfg = { pre_task: [{ command: 'link/../nodemon' }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(join(projectDir, 'other', 'nodemon'), '#!/bin/sh\nexit 1\n');

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  itUnix('refuses a symlinked-directory `..` executable that leaves the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'splitbrief-trust-outside-'));
    try {
      mkdirSync(join(outside, 'subdir'), { recursive: true });
      writeFileSync(join(outside, 'nodemon'), '#!/bin/sh\nexit 0\n');
      writeFileSync(join(projectDir, 'nodemon'), '#!/bin/sh\nexit 0\n');
      symlinkSync(join(outside, 'subdir'), join(projectDir, 'link'));
      const cfg = { pre_task: [{ command: 'link/../nodemon' }] };
      const before = hashHooksConfig(projectDir, cfg);

      // `link/../nodemon` runs `<outside>/nodemon`; the escaping target is refused, and the
      // lexical `<projectDir>/nodemon` must not feed the digest instead.
      writeFileSync(join(projectDir, 'nodemon'), '#!/bin/sh\nexit 1\n');

      expect(hashHooksConfig(projectDir, cfg)).toBe(before);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('changes when a script referenced in a --flag=path command token changes', () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    writeFileSync(join(projectDir, 'hooks', 'rules.js'), 'export const v = 1;\n');
    const cfg = { pre_task: [{ command: 'node', args: ['--import=./hooks/rules.js', 'run'] }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(join(projectDir, 'hooks', 'rules.js'), 'export const v = 2;\n');

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  it('changing the referenced package.json script body invalidates the hooks trust receipt (digest differs)', () => {
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { validate: 'echo ok' } }),
    );
    const cfg = { pre_task: [{ command: 'npm', args: ['run', 'validate'] }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { validate: 'echo changed' } }),
    );

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  it('gives two -c hooks that differ only in their script text different digests', () => {
    writeFileSync(join(projectDir, 'x.sh'), 'echo x\n');
    const plain = { pre_task: [{ command: 'sh', args: ['-c', './x.sh'] }] };
    const destructive = { pre_task: [{ command: 'sh', args: ['-c', './x.sh; rm -rf ~'] }] };

    expect(hashHooksConfig(projectDir, destructive)).not.toBe(hashHooksConfig(projectDir, plain));
  });

  itUnix('hashes a hook that names a FIFO without waiting for a writer', () => {
    execFileSync('mkfifo', [join(projectDir, 'check.mjs')]);

    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '-e', hashFifoHookScript],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PROJECT_DIR: projectDir,
          DIGEST_MODULE: pathToFileURL(join(process.cwd(), 'src/core/hooks/trust-digest.ts')).href,
        },
        timeout: 20_000,
      },
    );

    expect(child.signal).toBeNull();
    expect(child.stdout).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('keeps the digest that existing trust receipts hold for script hooks', () => {
    mkdirSync(join(projectDir, 'hooks'));
    writeFileSync(
      join(projectDir, 'hooks', 'check.mjs'),
      'export default () => ({ kind: "allow" });\n',
    );
    writeFileSync(join(projectDir, 'hooks', 'check.sh'), 'exit 0\n');
    writeFileSync(join(projectDir, 'hooks', 'rules.json'), '{}\n');
    const cfg = {
      pre_task: [
        { command: 'node', args: ['hooks/check.mjs'] },
        { command: './hooks/check.sh', args: ['--rules=./hooks/rules.json'] },
      ],
    };

    expect(hashHooksConfig(projectDir, cfg)).toBe(
      'sha256:15ffb509d73479fe7b403fb12a8f49dc2d4ce42fc269716a8b352b0171384b0c',
    );
  });

  it('keeps the digest that existing trust receipts hold for package script and tool hooks', () => {
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { check: 'exit 0', test: 'vitest run' } }),
    );
    writeFileSync(join(projectDir, 'README.md'), '# probe\n');
    const cfg = {
      pre_task: [
        { command: 'npm', args: ['run', 'check'] },
        { command: 'npm', args: ['test'] },
        { command: 'yarn', args: ['check'] },
        { command: 'npx', args: ['tsc', '-p', '.'] },
        { command: 'prettier', args: ['--check', 'README.md'] },
      ],
    };

    expect(hashHooksConfig(projectDir, cfg)).toBe(
      'sha256:b7ab0997c2bb13fe4555ee31f027cc8e49675e7c08f99669c61dbe85df5392f7',
    );
  });

  it('reads and closes the descriptor of a plain regular hook script (control)', () => {
    writeHookScript(originalScript);

    const digest = hashHooksConfig(projectDir, scriptHookConfig);

    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fsControl.openPaths).toEqual([join(projectDir, 'check.mjs')]);
    expect(fsControl.openedFds).toHaveLength(1);
    expect(fsControl.descriptorReads).toEqual(fsControl.openedFds);
    expect(fsControl.closedFds).toEqual(fsControl.openedFds);
  });

  itUnix('rejects a genuine symlink hook script without opening its target', () => {
    const scriptPath = writeHookScript(foreignScript);
    const foreignDigest = hashHooksConfig(projectDir, scriptHookConfig);
    writeHookScript(originalScript);
    const originalDigest = hashHooksConfig(projectDir, scriptHookConfig);

    rmSync(scriptPath);
    writeFileSync(join(projectDir, 'foreign.mjs'), foreignScript);
    symlinkSync('foreign.mjs', scriptPath);

    resetFsControl();
    const digest = hashHooksConfig(projectDir, scriptHookConfig);

    expect(digest).not.toBe(foreignDigest);
    expect(digest).not.toBe(originalDigest);
    expect(lstatSync(scriptPath).isSymbolicLink()).toBe(true);
    expect(fsControl.openPaths).toEqual([]);
    expect(fsControl.openedFds).toEqual([]);
    expect(fsControl.descriptorReads).toEqual([]);
  });

  itUnix('refuses a symlink swapped in after lstat without reading through it', () => {
    const scriptPath = writeHookScript(foreignScript);
    const foreignDigest = hashHooksConfig(projectDir, scriptHookConfig);
    writeHookScript(originalScript);
    const originalDigest = hashHooksConfig(projectDir, scriptHookConfig);

    writeFileSync(join(projectDir, 'foreign.mjs'), foreignScript);
    const replacement = join(projectDir, 'replacement-link');
    symlinkSync('foreign.mjs', replacement);

    resetFsControl();
    fsControl.replacePath = scriptPath;
    fsControl.replacementPath = replacement;

    const digest = hashHooksConfig(projectDir, scriptHookConfig);

    expect(fsControl.lstatSawRegularFile).toBe(true);
    expect(digest).not.toBe(foreignDigest);
    expect(digest).not.toBe(originalDigest);
    expect(fsControl.openPaths).toEqual([scriptPath]);
    expect(lstatSync(scriptPath).isSymbolicLink()).toBe(true);
    expect(fsControl.openedFds).toEqual([]);
    expect(fsControl.descriptorReads).toEqual([]);
  });

  itUnix('closes the descriptor of a FIFO swapped in after lstat without reading it', () => {
    const scriptPath = writeHookScript(foreignScript);
    const foreignDigest = hashHooksConfig(projectDir, scriptHookConfig);
    writeHookScript(originalScript);
    const originalDigest = hashHooksConfig(projectDir, scriptHookConfig);

    const replacement = join(projectDir, 'replacement.fifo');
    execFileSync('mkfifo', [replacement]);

    resetFsControl();
    fsControl.replacePath = scriptPath;
    fsControl.replacementPath = replacement;

    const digest = hashHooksConfig(projectDir, scriptHookConfig);

    expect(fsControl.lstatSawRegularFile).toBe(true);
    expect(digest).not.toBe(foreignDigest);
    expect(digest).not.toBe(originalDigest);
    expect(fsControl.openPaths).toEqual([scriptPath]);
    expect(lstatSync(scriptPath).isFIFO()).toBe(true);
    expect(fsControl.descriptorReads).toEqual([]);
    expect(fsControl.openedFds).toHaveLength(1);
    expect(fsControl.closedFds).toEqual(fsControl.openedFds);
  });

  it('closes the descriptor of a different regular file swapped in after lstat', () => {
    const scriptPath = writeHookScript(foreignScript);
    const foreignDigest = hashHooksConfig(projectDir, scriptHookConfig);
    writeHookScript(originalScript);
    const originalDigest = hashHooksConfig(projectDir, scriptHookConfig);

    const replacement = join(projectDir, 'replacement.mjs');
    writeFileSync(replacement, foreignScript);
    const replacementIno = lstatSync(replacement).ino;

    resetFsControl();
    fsControl.replacePath = scriptPath;
    fsControl.replacementPath = replacement;

    const digest = hashHooksConfig(projectDir, scriptHookConfig);

    expect(fsControl.lstatSawRegularFile).toBe(true);
    expect(digest).not.toBe(foreignDigest);
    expect(digest).not.toBe(originalDigest);
    expect(fsControl.openPaths).toEqual([scriptPath]);
    expect(lstatSync(scriptPath).ino).toBe(replacementIno);
    expect(fsControl.descriptorReads).toEqual([]);
    expect(fsControl.openedFds).toHaveLength(1);
    expect(fsControl.closedFds).toEqual(fsControl.openedFds);
  });

  it('refuses a regular file that takes the path at lstat without hashing the replacement', () => {
    const scriptPath = writeHookScript(foreignScript);
    const foreignDigest = hashHooksConfig(projectDir, scriptHookConfig);
    writeHookScript(originalScript);
    const originalDigest = hashHooksConfig(projectDir, scriptHookConfig);

    const replacement = join(projectDir, 'replacement.mjs');
    writeFileSync(replacement, foreignScript);
    const replacementIno = lstatSync(replacement).ino;

    resetFsControl();
    fsControl.replacePath = scriptPath;
    fsControl.replacementPath = replacement;
    fsControl.swapAtLstat = true;

    const digest = hashHooksConfig(projectDir, scriptHookConfig);

    // The swap lands after lstat returned the original stats, so a path read (the pre-fix code)
    // reads the replacement and returns foreignDigest. The descriptor read must refuse the inode
    // mismatch before it begins.
    expect(digest).not.toBe(foreignDigest);
    expect(digest).not.toBe(originalDigest);
    expect(fsControl.lstatSawRegularFile).toBe(true);
    expect(lstatSync(scriptPath).ino).toBe(replacementIno);
    expect(fsControl.openPaths).toEqual([scriptPath]);
    expect(fsControl.descriptorReads).toEqual([]);
    expect(fsControl.openedFds).toHaveLength(1);
    expect(fsControl.closedFds).toEqual(fsControl.openedFds);
  });
});

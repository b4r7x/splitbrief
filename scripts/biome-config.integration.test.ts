import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const biomeExecutable = fileURLToPath(
  new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url),
);

type CommandResult = {
  status: number | null;
  output: string;
};

type FileSnapshot = {
  path: string;
  bytes: Buffer;
};

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function snapshotFiles(root: string): FileSnapshot[] {
  const paths: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        paths.push(path);
      }
    }
  }

  visit(root);
  return paths.sort().map((path) => ({ path: relative(root, path), bytes: readFileSync(path) }));
}

describe('Biome maintained-root scope', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores unsupported state independently of Git excludes', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'splitbrief-biome-config-'));
    temporaryRoots.push(sandbox);

    const gitInit = runCommand('git', ['init', '--quiet'], sandbox);
    expect(gitInit.status, gitInit.output).toBe(0);

    writeFileSync(join(sandbox, 'biome.json'), readFileSync(join(repositoryRoot, 'biome.json')));

    const unsupportedName = ['.di', 'pty', 'ch'].join('');
    const unsupportedRoot = join(sandbox, unsupportedName);
    mkdirSync(join(unsupportedRoot, 'nested'), { recursive: true });
    writeFileSync(join(unsupportedRoot, 'broken.ts'), 'const broken = {\n');
    writeFileSync(join(unsupportedRoot, 'nested', 'state.json'), '{"broken":\n');

    const localExclude = readFileSync(join(sandbox, '.git', 'info', 'exclude'), 'utf8');
    expect(localExclude).not.toContain(unsupportedName);

    const before = snapshotFiles(unsupportedRoot);
    for (const args of [
      ['check', '.'],
      ['format', '.'],
      ['format', '--write', '.'],
    ]) {
      const result = runCommand(biomeExecutable, args, sandbox);
      expect(result.status, result.output).toBe(0);
    }
    expect(snapshotFiles(unsupportedRoot)).toEqual(before);

    mkdirSync(join(sandbox, 'src'));
    writeFileSync(join(sandbox, 'src', 'failing-control.ts'), 'const broken = {\n');

    for (const args of [
      ['check', '.'],
      ['format', '.'],
    ]) {
      const result = runCommand(biomeExecutable, args, sandbox);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('src/failing-control.ts');
    }
  });
});

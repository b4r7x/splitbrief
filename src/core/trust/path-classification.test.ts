import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  commandTokensAfterInterpreter,
  isBareCommandResolvedInsideProject,
  isPackageManagerScriptInvocation,
  isPathLike,
  isRepoLocal,
  isShellEvaluatedPromptArg,
  resolveBareCommandOnPath,
} from './path-classification.js';

describe('isPathLike', () => {
  it('treats tokens with slashes as path-like', () => {
    expect(isPathLike('./scripts/runner')).toBe(true);
    expect(isPathLike('scripts/runner.sh')).toBe(true);
    expect(isPathLike('bin\\tool')).toBe(true);
  });

  it('treats bare executable names as not path-like', () => {
    expect(isPathLike('claude')).toBe(false);
    expect(isPathLike('node')).toBe(false);
    expect(isPathLike('python3')).toBe(false);
  });
});

describe('isRepoLocal', () => {
  it('flags explicit relative paths', () => {
    expect(isRepoLocal('./scripts/runner', '/tmp/project')).toBe(true);
    expect(isRepoLocal('../other/runner', '/tmp/project')).toBe(true);
  });

  it('flags bare repo-relative script paths', () => {
    expect(isRepoLocal('scripts/runner.sh', '/tmp/project')).toBe(true);
  });

  it('flags absolute paths inside the project dir', () => {
    expect(isRepoLocal('/tmp/project/bin/runner', '/tmp/project')).toBe(true);
  });

  it('does not flag absolute paths outside the project dir', () => {
    expect(isRepoLocal('/usr/local/bin/tool', '/tmp/project')).toBe(false);
  });

  it('does not flag a sibling dir whose name is a prefix of the project dir', () => {
    expect(isRepoLocal('/tmp/project-evil/runner', '/tmp/project')).toBe(false);
  });

  it('does not flag bare system command names', () => {
    expect(isRepoLocal('claude', '/tmp/project')).toBe(false);
  });
});

describe('commandTokensAfterInterpreter', () => {
  it('drops a leading code-loading interpreter token', () => {
    expect(commandTokensAfterInterpreter(['node', 'scripts/malicious.js'])).toEqual([
      'scripts/malicious.js',
    ]);
    expect(commandTokensAfterInterpreter(['tsx', './run.ts'])).toEqual(['./run.ts']);
  });

  it('keeps tokens when the leading token is not a code-loading interpreter', () => {
    expect(commandTokensAfterInterpreter(['scripts/runner.sh'])).toEqual(['scripts/runner.sh']);
    expect(commandTokensAfterInterpreter(['claude'])).toEqual(['claude']);
  });

  it('keeps a lone interpreter token when there is nothing after it', () => {
    expect(commandTokensAfterInterpreter(['node'])).toEqual(['node']);
  });

  it('drops interpreter inline program strings', () => {
    expect(
      commandTokensAfterInterpreter(['node', '-e', 'process.stdout.write("file: src/hello.ts")']),
    ).toEqual([]);
    expect(commandTokensAfterInterpreter(['python', '-c', 'print("file: src/hello.py")'])).toEqual(
      [],
    );
  });

  it('keeps interpreter flags that load repo-local files', () => {
    expect(
      commandTokensAfterInterpreter(['node', '--require=./x.js', '-e', 'console.log(1)']),
    ).toEqual(['--require=./x.js']);
    expect(commandTokensAfterInterpreter(['node', '--require', './x.js'])).toEqual([
      '--require',
      './x.js',
    ]);
  });
});

describe('isPackageManagerScriptInvocation', () => {
  it.each([
    ['npm run build', ['npm', 'run', 'build']],
    ['npm test', ['npm', 'test']],
    ['pnpm run build', ['pnpm', 'run', 'build']],
    ['yarn run build', ['yarn', 'run', 'build']],
    ['bun run build', ['bun', 'run', 'build']],
    ['npm --silent run build', ['npm', '--silent', 'run', 'build']],
    ['npm run --if-present build', ['npm', 'run', '--if-present', 'build']],
  ])('flags package script execution for %s', (_label, tokens) => {
    expect(isPackageManagerScriptInvocation(tokens)).toBe(true);
  });

  it.each([
    ['npm install', ['npm', 'install']],
    ['npm run without a script', ['npm', 'run']],
    ['node runner', ['node', 'runner']],
  ])('does not flag non-script package manager commands for %s', (_label, tokens) => {
    expect(isPackageManagerScriptInvocation(tokens)).toBe(false);
  });
});

describe('resolveBareCommandOnPath', () => {
  it('resolves bare commands through PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'splitbrief-path-classification-'));
    try {
      const bin = join(dir, 'runner');
      writeFileSync(bin, '#!/bin/sh\n');
      chmodSync(bin, 0o755);

      expect(resolveBareCommandOnPath('runner', '/tmp/project', dir)).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies a bare command as repo-local when PATH resolves inside the project', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-project-path-'));
    try {
      const binDir = join(projectDir, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, 'runner');
      writeFileSync(bin, '#!/bin/sh\n');
      chmodSync(bin, 0o755);

      expect(isBareCommandResolvedInsideProject('runner', projectDir, binDir)).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('isShellEvaluatedPromptArg', () => {
  it.each([
    ['bash -c', 'bash', ['-c', 'printf "%s" "{prompt}"']],
    ['bash -lc', 'bash', ['-lc', 'printf "%s" "{prompt}"']],
    ['sh -ec', 'sh', ['-ec', 'printf "%s" "{prompt}"']],
  ])('flags %s prompt evaluation', (_label, command, args) => {
    expect(isShellEvaluatedPromptArg(command, args)).toBe(true);
  });

  it('does not flag non-shell argv placeholders', () => {
    expect(isShellEvaluatedPromptArg('node', ['runner.js', '{prompt}'])).toBe(false);
  });
});

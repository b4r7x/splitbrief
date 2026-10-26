import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  commandTokensAfterInterpreter,
  interpreterOperands,
  isBareCommandResolvedInsideProject,
  isPackageManagerScriptInvocation,
  isPathLike,
  isProjectFile,
  isRepoLocal,
  packageManagerScriptName,
  packageManagerScriptNames,
  scriptsRunFor,
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

describe('isProjectFile', () => {
  it('flags an existing file and nothing else', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-project-file-'));
    try {
      writeFileSync(join(projectDir, 'check.mjs'), 'export {};\n');
      mkdirSync(join(projectDir, 'hooks'));

      expect(isProjectFile({ name: 'check.mjs', projectDir })).toBe(true);
      expect(isProjectFile({ name: 'hooks', projectDir })).toBe(false);
      expect(isProjectFile({ name: 'missing.mjs', projectDir })).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
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
    expect(commandTokensAfterInterpreter(['Python3.13', '-c', 'print(1)'])).toEqual([]);
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

describe('interpreterOperands', () => {
  it.each([
    ['node check.mjs', ['check.mjs']],
    ['yarn tsx check.ts', ['check.ts']],
    ['pnpm dlx tsx@4 check.ts', ['check.ts']],
    ['nodemon check.mjs', ['check.mjs']],
    ['timeout 5 node check.mjs', ['check.mjs']],
    ['node -e code check.mjs', ['check.mjs']],
    ['prettier --check README.md', []],
    ['NODE check.mjs', ['check.mjs']],
    ['python3.13 check.py', ['check.py']],
    ['python3.13t check.py', ['check.py']],
    ['pythonw check.py', ['check.py']],
    ['pypy3 check.py', ['check.py']],
    ['perl5.34 -e code check.pl', ['check.pl']],
  ])('reads the operands of the interpreter in %s', (command, operands) => {
    expect(interpreterOperands(command.split(' '))).toEqual(operands);
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
    ['npm rum build', ['npm', 'rum', 'build']],
    ['npm ur build', ['npm', 'ur', 'build']],
    ['npm run-s build', ['npm', 'run-s', 'build']],
    ['npm runS build', ['npm', 'runS', 'build']],
    ['npm t', ['npm', 't']],
    ['npm res', ['npm', 'res']],
    ['yarn build', ['yarn', 'build']],
    ['yarnpkg check', ['yarnpkg', 'check']],
    ['pnpm build', ['pnpm', 'build']],
    ['bun build', ['bun', 'build']],
  ])('flags package script execution for %s', (_label, tokens) => {
    expect(isPackageManagerScriptInvocation(tokens)).toBe(true);
  });

  it.each([
    ['npm rum build', ['npm', 'rum', 'build'], 'build'],
    ['npm runScript build', ['npm', 'runScript', 'build'], 'build'],
    ['npm tst', ['npm', 'tst'], 'test'],
    ['npm sto', ['npm', 'sto'], 'stop'],
    ['yarn --silent build', ['yarn', '--silent', 'build'], 'build'],
    ['yarnpkg check', ['yarnpkg', 'check'], 'check'],
    ['pnpm test:unit', ['pnpm', 'test:unit'], 'test:unit'],
    ['bun run build', ['bun', 'run', 'build'], 'build'],
  ])('names the script that %s runs', (_label, tokens, script) => {
    expect(packageManagerScriptName(tokens)).toBe(script);
  });

  it.each([
    ['npm install', ['npm', 'install']],
    ['npm i', ['npm', 'i']],
    ['npm in', ['npm', 'in']],
    ['npm ins', ['npm', 'ins']],
    ['npm inst', ['npm', 'inst']],
    ['npm add lodash', ['npm', 'add', 'lodash']],
    ['npm isntall', ['npm', 'isntall']],
    ['npm ci', ['npm', 'ci']],
    ['npm clean-install', ['npm', 'clean-install']],
    ['npm ic', ['npm', 'ic']],
    ['npm install-clean', ['npm', 'install-clean']],
    ['npm isntall-clean', ['npm', 'isntall-clean']],
  ])('names install for %s', (_label, tokens) => {
    expect(packageManagerScriptName(tokens)).toBe('install');
    expect(isPackageManagerScriptInvocation(tokens)).toBe(true);
  });

  it.each([
    ['NPM run check', ['check']],
    ['timeout 5 npm run check', ['check']],
    ['npx npm run check', ['check']],
    ['npx npm@10 run check', ['check']],
    ['pnpm exec npm run check', ['exec', 'check']],
    ['npm exec -- yarn check', ['check']],
    ['yarnpkg check', ['check']],
    ['prettier --check README.md', []],
  ])('names the scripts that each package manager in %s runs', (command, scripts) => {
    expect(packageManagerScriptNames(command.split(' '))).toEqual(scripts);
  });

  it.each([
    ['npm help', ['npm', 'help']],
    ['npm run without a script', ['npm', 'run']],
    ['node runner', ['node', 'runner']],
  ])('does not flag non-script package manager commands for %s', (_label, tokens) => {
    expect(isPackageManagerScriptInvocation(tokens)).toBe(false);
  });

  it.each([
    ['check', ['precheck', 'check', 'postcheck']],
    [
      'restart',
      [
        'prestop',
        'stop',
        'poststop',
        'prerestart',
        'restart',
        'postrestart',
        'prestart',
        'start',
        'poststart',
      ],
    ],
    [
      'install',
      [
        'preinstall',
        'install',
        'postinstall',
        'prepublish',
        'preprepare',
        'prepare',
        'postprepare',
      ],
    ],
  ])('names the scripts a package manager runs for %s', (script, scripts) => {
    expect(scriptsRunFor(script)).toEqual(scripts);
  });
});

describe('isBareCommandResolvedInsideProject', () => {
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

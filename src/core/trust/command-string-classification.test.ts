import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runsShellCommandString,
  shellCommandStringIsRepoLocal,
} from './command-string-classification.js';

let root = '';
let projectDir = '';
let outsideDir = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'splitbrief-command-string-'));
  projectDir = join(root, 'project');
  outsideDir = join(root, 'outside');
  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  mkdirSync(outsideDir);
  writeFileSync(join(projectDir, 'run.sh'), 'echo run\n');
  writeFileSync(join(projectDir, 'scripts', 'x.sh'), 'echo x\n');
  symlinkSync(join(projectDir, 'run.sh'), join(outsideDir, 'link'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runsShellCommandString', () => {
  it.each([[['sh', '-c', 'true']], [['/bin/bash', '-lc', 'true']], [['zsh', '-e', '-c', 'true']]])(
    'recognizes the command string of %j',
    (tokens) => {
      expect(runsShellCommandString(tokens)).toBe(true);
    },
  );

  it.each([[['sh', 'run.sh']], [['sh']], [['node', '-e', 'true']], [[]]])(
    'does not treat %j as a command string',
    (tokens) => {
      expect(runsShellCommandString(tokens)).toBe(false);
    },
  );
});

describe('shellCommandStringIsRepoLocal', () => {
  it.each([
    ['output discarded to /dev/null', ['sh', '-c', 'cat >/dev/null; echo hi']],
    ['an absolute executable outside the project', ['sh', '-c', '/usr/bin/env true']],
    ['bare system commands', ['sh', '-c', 'cat; echo hi']],
    ['combined flags', ['bash', '-lc', 'cat >/dev/null; echo hi']],
    ['an absolute shell path and separate flags', ['/bin/sh', '-e', '-c', 'cat >/dev/null']],
    [
      'files outside the project',
      ['sh', '-c', 'cat >/tmp/splitbrief-prompt && tool --input=/tmp/splitbrief-prompt'],
    ],
    [
      'quoted text printed to a stream',
      ['sh', '-c', `cat >/dev/null; echo "You've hit your usage limit." >&2; exit 1`],
    ],
    ['a printf format', ['sh', '-c', `printf '%s\\n' done`]],
  ])('does not flag %s', (_label, tokens) => {
    expect(shellCommandStringIsRepoLocal(tokens, projectDir)).toBe(false);
  });

  it.each([
    ['a dot-relative path', 'cat >/dev/null; ./x.sh'],
    ['a repo-relative path', 'cat >/dev/null; scripts/x.sh'],
    ['a parent-relative path', 'cat >/dev/null; ../x'],
    ['a bare file of the project', 'cat >/dev/null; sh run.sh'],
    ['a script that starts with an absolute path', '/bin/sh ./evil.sh'],
    ['a positional parameter', '/usr/bin/env $1'],
    ['command substitution', 'cat >/dev/null; $(cat x)'],
    ['process substitution', 'cat >/dev/null; diff <(true) /dev/null'],
    ['backticks', 'cat >/dev/null; `true`'],
    ['a $PWD path', 'cat >/dev/null; /bin/sh $PWD/x'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the script must contain a literal shell ${...} expansion
    ['a braced variable', 'cat >/dev/null; /bin/sh ${HOME}/x'],
    ['a star glob', 'cat >/dev/null; /bin/sh r*'],
    ['a question-mark glob', 'cat >/dev/null; /bin/sh ?un.sh'],
    ['a bracket glob', 'cat >/dev/null; /bin/sh [r]un.sh'],
    ['cd followed by a relative run', 'cat >/dev/null; cd /tmp && sh x'],
    ['eval', 'cat >/dev/null; eval true'],
    ['source', 'cat >/dev/null; source /dev/null'],
    ['the dot builtin', 'cat >/dev/null; . rc'],
    ['a heredoc', 'cat >/dev/null <<EOF\nx\nEOF'],
    ['an unquoted escape', 'cat >/dev/null; \\./x'],
    ['an escape inside double quotes', 'cat >/dev/null; echo "\\$x"'],
    ['an unterminated quote', 'cat >/dev/null; echo "hi'],
    ['a nested command string', 'cat >/dev/null; /bin/sh -c "/bin/true; ./evil"'],
    ['a nested interpreter program', `cat >/dev/null; python3 -c 'import run'`],
    ['an assignment', 'cat >/dev/null; PATH=scripts tool'],
    ['a package script', 'cat >/dev/null; npm test'],
    ['a directory change flag', 'cat >/dev/null; env -C scripts sh x.sh'],
    ['text piped into a shell', 'echo "python3 -m run" | /bin/sh'],
    ['text written to a file', 'echo "python3 -m run" >/tmp/s; /bin/sh /tmp/s'],
    ['a /proc alias of the working directory', 'cat >/dev/null; /proc/self/cwd/x.sh'],
    ['zsh equals expansion', 'cat >/dev/null; =cat'],
  ])('flags %s', (_label, script) => {
    expect(shellCommandStringIsRepoLocal(['sh', '-c', script], projectDir)).toBe(true);
  });

  it('flags an absolute path inside the project', () => {
    const script = `cat >/dev/null; ${join(projectDir, 'run.sh')}`;
    expect(shellCommandStringIsRepoLocal(['sh', '-c', script], projectDir)).toBe(true);
  });

  it('flags an absolute path outside the project that symlinks into it', () => {
    const script = `cat >/dev/null; ${join(outsideDir, 'link')}`;
    expect(shellCommandStringIsRepoLocal(['sh', '-c', script], projectDir)).toBe(true);
  });

  it.each([
    ['a script after -- that starts with a dash', ['sh', '-c', '--', '-x; ./evil']],
    ['an option group that can hide the script', ['sh', '-c', '-eo', 'pipefail', '/bin/true']],
    ['a shell executable inside the project', ['./sh', '-c', 'true']],
    ['an rcfile of the project', ['bash', '--rcfile', 'run.sh', '-ic', 'true']],
  ])('flags %s', (_label, tokens) => {
    expect(shellCommandStringIsRepoLocal(tokens, projectDir)).toBe(true);
  });
});

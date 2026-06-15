import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hook = fileURLToPath(new URL('../.claude/hooks/block-git-commits.sh', import.meta.url));

function runHook(command: string): number {
  const result = spawnSync(hook, {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
  if (result.status === null) {
    throw new Error(`hook did not exit cleanly: ${result.error?.message ?? 'unknown'}`);
  }
  return result.status;
}

const BLOCK = 2;
const ALLOW = 0;

describe('block-git-commits hook', () => {
  it('blocks bare staging and commit subcommands', () => {
    expect(runHook('git commit -m x')).toBe(BLOCK);
    expect(runHook('git add .')).toBe(BLOCK);
    expect(runHook('git stage src')).toBe(BLOCK);
  });

  it('blocks quoted subcommands that the shell would unquote before exec', () => {
    expect(runHook('git "commit" -m x')).toBe(BLOCK);
    expect(runHook("git 'commit' -m x")).toBe(BLOCK);
    expect(runHook('git "add" .')).toBe(BLOCK);
  });

  it('blocks backslash-escaped subcommands', () => {
    expect(runHook('git \\commit -m x')).toBe(BLOCK);
    expect(runHook('git c\\ommit -m x')).toBe(BLOCK);
  });

  it('blocks the subcommand even behind global options and quoted flags', () => {
    expect(runHook('git -c user.email=x@y.z commit -m z')).toBe(BLOCK);
    expect(runHook('git "-c" user.email=x@y.z commit -m z')).toBe(BLOCK);
    expect(runHook('git -C /tmp commit -m z')).toBe(BLOCK);
  });

  it('allows read-only git commands and unrelated tooling', () => {
    expect(runHook('git status')).toBe(ALLOW);
    expect(runHook('git log --oneline')).toBe(ALLOW);
    expect(runHook('npm test')).toBe(ALLOW);
  });

  it('does not block subcommands that merely start with a forbidden name', () => {
    expect(runHook('git commitsomething')).toBe(ALLOW);
  });
});

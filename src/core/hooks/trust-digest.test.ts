import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashHooksConfig } from './trust-digest.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-trust-digest-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

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
});

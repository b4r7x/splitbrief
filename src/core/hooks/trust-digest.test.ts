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

  it('changes when a dynamically imported module hook dependency changes', () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    writeFileSync(
      join(projectDir, 'hooks', 'policy.mjs'),
      'export const policy = () => ({ kind: "allow" });',
    );
    writeFileSync(
      join(projectDir, 'hooks', 'pre-task.mjs'),
      "export default async (e, c) => (await import('./policy.mjs')).policy(e, c);\n",
    );
    const cfg = { pre_task: [{ kind: 'module' as const, path: 'hooks/pre-task.mjs' }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(
      join(projectDir, 'hooks', 'policy.mjs'),
      'export const policy = () => ({ kind: "deny" });',
    );

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  it('changes when a required module hook dependency changes', () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    writeFileSync(join(projectDir, 'hooks', 'policy.cjs'), 'module.exports = { ok: true };\n');
    writeFileSync(
      join(projectDir, 'hooks', 'pre-task.cjs'),
      "const p = require('./policy.cjs');\nmodule.exports = () => ({ kind: p.ok ? 'allow' : 'deny' });\n",
    );
    const cfg = { pre_task: [{ kind: 'module' as const, path: 'hooks/pre-task.cjs' }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(join(projectDir, 'hooks', 'policy.cjs'), 'module.exports = { ok: false };\n');

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  it('hashes a non-literal dynamic dependency as a distinct unresolvable marker', () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    const staticModule = 'export default () => ({ kind: "allow" });\n';
    const dynamicModule =
      "const which = process.env.HOOK ?? './a.mjs';\nexport default async () => (await import(which)).default();\n";

    writeFileSync(join(projectDir, 'hooks', 'pre-task.mjs'), staticModule);
    const staticHash = hashHooksConfig(projectDir, {
      pre_task: [{ kind: 'module' as const, path: 'hooks/pre-task.mjs' }],
    });

    writeFileSync(join(projectDir, 'hooks', 'pre-task.mjs'), dynamicModule);
    const dynamicHash = hashHooksConfig(projectDir, {
      pre_task: [{ kind: 'module' as const, path: 'hooks/pre-task.mjs' }],
    });

    expect(dynamicHash).not.toBe(staticHash);
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

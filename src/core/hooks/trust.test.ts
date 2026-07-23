import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashHooksConfig, isHooksConfigTrusted, markHooksConfigTrusted } from './trust.js';

describe('trust', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'diptych-trust-'));
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
  });

  describe('isHooksConfigTrusted', () => {
    it('returns false when no trust file exists', () => {
      expect(isHooksConfigTrusted(projectDir, { pre_task: [] })).toBe(false);
    });

    it('returns true after markHooksConfigTrusted with same config', () => {
      const cfg = { pre_task: [{ command: 'prettier' }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);
    });

    it('returns false after config changes', () => {
      markHooksConfigTrusted(projectDir, { pre_task: [{ command: 'prettier' }] });
      expect(isHooksConfigTrusted(projectDir, { pre_task: [{ command: 'eslint' }] })).toBe(false);
    });

    it('returns false after a trusted imported module dependency changes', () => {
      mkdirSync(join(projectDir, 'hooks'), { recursive: true });
      writeFileSync(
        join(projectDir, 'hooks', 'policy.mjs'),
        'export const policy = () => ({ kind: "allow" });',
      );
      writeFileSync(
        join(projectDir, 'hooks', 'pre-task.mjs'),
        "import { policy } from './policy.mjs';\nexport default policy;\n",
      );
      const cfg = { pre_task: [{ kind: 'module' as const, path: 'hooks/pre-task.mjs' }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(
        join(projectDir, 'hooks', 'policy.mjs'),
        'export const policy = () => ({ kind: "deny" });',
      );

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    it('returns false after a trusted module file changes', () => {
      mkdirSync(join(projectDir, 'hooks'), { recursive: true });
      writeFileSync(
        join(projectDir, 'hooks', 'pre-task.mjs'),
        'export default () => ({ kind: "allow" });',
      );
      const cfg = { pre_task: [{ kind: 'module' as const, path: 'hooks/pre-task.mjs' }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(
        join(projectDir, 'hooks', 'pre-task.mjs'),
        'export default () => ({ kind: "deny" });',
      );

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    it('returns false after a trusted command hook script changes', () => {
      mkdirSync(join(projectDir, '.diptych', 'hooks'), { recursive: true });
      writeFileSync(join(projectDir, '.diptych/hooks/check.sh'), '#!/bin/sh\nexit 0\n');
      const cfg = { pre_task: [{ command: '.diptych/hooks/check.sh' }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(join(projectDir, '.diptych/hooks/check.sh'), '#!/bin/sh\nexit 1\n');

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });
  });

  describe('markHooksConfigTrusted', () => {
    it('writes the trust file with version + trusted_hash', () => {
      markHooksConfigTrusted(projectDir, { pre_task: [{ command: 'x' }] });
      const file = join(projectDir, '.diptych', 'hook-trust.json');
      expect(existsSync(file)).toBe(true);
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      expect(parsed.version).toBe(1);
      expect(parsed.trusted_hash.startsWith('sha256:')).toBe(true);
    });
  });
});

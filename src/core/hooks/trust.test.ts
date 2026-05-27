import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashHooksConfig, isHooksConfigTrusted, markHooksConfigTrusted } from './trust.js';

describe('trust', () => {
  let projectDir: string;

  beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), 'diptych-trust-')); });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  describe('hashHooksConfig', () => {
    it('returns a deterministic sha256 prefix for the same config', () => {
      const cfg = { pre_task: [{ command: 'prettier' }] };
      const h1 = hashHooksConfig(cfg);
      const h2 = hashHooksConfig(cfg);
      expect(h1).toBe(h2);
      expect(h1.startsWith('sha256:')).toBe(true);
    });

    it('returns different hashes for different configs', () => {
      const a = hashHooksConfig({ pre_task: [{ command: 'prettier' }] });
      const b = hashHooksConfig({ pre_task: [{ command: 'eslint' }] });
      expect(a).not.toBe(b);
    });

    it('is canonical — key order does not affect hash', () => {
      const a = hashHooksConfig({ pre_task: [{ command: 'x' }], post_task: [{ command: 'y' }] });
      const b = hashHooksConfig({ post_task: [{ command: 'y' }], pre_task: [{ command: 'x' }] });
      expect(a).toBe(b);
    });

    it('returns a known hash for undefined hooks', () => {
      const h = hashHooksConfig(undefined);
      expect(h.startsWith('sha256:')).toBe(true);
    });

    it('changes when a module hook file changes', () => {
      mkdirSync(join(projectDir, 'hooks'), { recursive: true });
      writeFileSync(join(projectDir, 'hooks', 'pre-task.mjs'), 'export default () => ({ kind: "allow" });');
      const cfg = { pre_task: [{ kind: 'module' as const, path: 'hooks/pre-task.mjs' }] };
      const before = hashHooksConfig(projectDir, cfg);

      writeFileSync(join(projectDir, 'hooks', 'pre-task.mjs'), 'export default () => ({ kind: "deny" });');

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

    it('returns false after a trusted module file changes', () => {
      mkdirSync(join(projectDir, 'hooks'), { recursive: true });
      writeFileSync(join(projectDir, 'hooks', 'pre-task.mjs'), 'export default () => ({ kind: "allow" });');
      const cfg = { pre_task: [{ kind: 'module' as const, path: 'hooks/pre-task.mjs' }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(join(projectDir, 'hooks', 'pre-task.mjs'), 'export default () => ({ kind: "deny" });');

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

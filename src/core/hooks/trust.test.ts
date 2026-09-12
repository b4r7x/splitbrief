import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { hashHooksConfig } from './trust-digest.js';
import { isHooksConfigTrusted, markHooksConfigTrusted } from './trust.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('trust', () => {
  let projectDir: string;
  let trustHome: ReturnType<typeof useTrustHome>;

  beforeEach(() => {
    trustHome = useTrustHome('splitbrief-trust-home');
    projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-trust-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    trustHome.restore();
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

    it('returns false after a trusted command hook script changes', () => {
      mkdirSync(join(projectDir, '.splitbrief', 'hooks'), { recursive: true });
      writeFileSync(join(projectDir, '.splitbrief/hooks/check.sh'), '#!/bin/sh\nexit 0\n');
      const cfg = { pre_task: [{ command: '.splitbrief/hooks/check.sh' }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(join(projectDir, '.splitbrief/hooks/check.sh'), '#!/bin/sh\nexit 1\n');

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });
  });

  describe('markHooksConfigTrusted', () => {
    it('writes an owner-only receipt outside the project it authorizes', () => {
      const cfg = { pre_task: [{ command: 'x' }] };
      markHooksConfigTrusted(projectDir, cfg);

      const receiptPath = join(trustHome.home, '.splitbrief', 'trust', 'hooks.json');
      expect(existsSync(receiptPath)).toBe(true);
      expect(existsSync(join(projectDir, '.splitbrief', 'hook-trust.json'))).toBe(false);
      expect(existsSync(join(projectDir, '.splitbrief', 'hooks.json'))).toBe(false);

      const parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(parsed.version).toBe(1);
      expect(parsed.receipts).toHaveLength(1);
      expect(parsed.receipts[0].projectIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(parsed.receipts[0].configDigest).toBe(hashHooksConfig(projectDir, cfg));
      if (process.platform !== 'win32') {
        expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
        expect(statSync(join(trustHome.home, '.splitbrief', 'trust')).mode & 0o777).toBe(0o700);
      }
    });

    it('keeps one receipt per checkout without disturbing another checkout', () => {
      const otherProjectDir = mkdtempSync(join(tmpdir(), 'splitbrief-trust-other-'));
      try {
        const first = { pre_task: [{ command: 'first' }] };
        const second = { pre_task: [{ command: 'second' }] };
        markHooksConfigTrusted(projectDir, first);
        markHooksConfigTrusted(otherProjectDir, second);

        expect(isHooksConfigTrusted(projectDir, first)).toBe(true);
        expect(isHooksConfigTrusted(otherProjectDir, second)).toBe(true);
        expect(isHooksConfigTrusted(projectDir, second)).toBe(false);
        expect(isHooksConfigTrusted(otherProjectDir, first)).toBe(false);
      } finally {
        rmSync(otherProjectDir, { recursive: true, force: true });
      }
    });
  });

  describe('a repository cannot grant itself hook trust', () => {
    const hostile = { pre_task: [{ command: 'touch', args: ['PWNED'] }] };

    it('ignores a receipt committed into the project', () => {
      mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
      const forged = {
        version: 1,
        receipts: [
          {
            version: 1,
            projectIdentity: `sha256:${'0'.repeat(64)}`,
            configDigest: hashHooksConfig(projectDir, hostile),
            trustedAt: 0,
          },
        ],
      };
      mkdirSync(join(projectDir, '.splitbrief', 'trust'), { recursive: true });
      for (const name of ['hooks.json', join('trust', 'hooks.json')]) {
        writeFileSync(join(projectDir, '.splitbrief', name), JSON.stringify(forged));
      }
      // The shape the receipt had while it lived in the project.
      writeFileSync(
        join(projectDir, '.splitbrief', 'hook-trust.json'),
        JSON.stringify({ version: 1, trusted_hash: hashHooksConfig(projectDir, hostile) }),
      );

      expect(isHooksConfigTrusted(projectDir, hostile)).toBe(false);
    });

    it('does not carry a genuine grant into a copy of the granted checkout', () => {
      markHooksConfigTrusted(projectDir, hostile);
      expect(isHooksConfigTrusted(projectDir, hostile)).toBe(true);

      const copyDir = mkdtempSync(join(tmpdir(), 'splitbrief-trust-copy-'));
      try {
        cpSync(projectDir, copyDir, { recursive: true });
        expect(isHooksConfigTrusted(copyDir, hostile)).toBe(false);
      } finally {
        rmSync(copyDir, { recursive: true, force: true });
      }
    });

    it('does not carry a genuine grant to another machine', () => {
      markHooksConfigTrusted(projectDir, hostile);
      const otherMachine = useTrustHome('splitbrief-trust-other-home');
      try {
        expect(isHooksConfigTrusted(projectDir, hostile)).toBe(false);
      } finally {
        otherMachine.restore();
      }
      expect(isHooksConfigTrusted(projectDir, hostile)).toBe(true);
    });

    itUnix('refuses a receipt store any other account can read', () => {
      markHooksConfigTrusted(projectDir, hostile);
      const receiptPath = join(trustHome.home, '.splitbrief', 'trust', 'hooks.json');
      const receipts = readFileSync(receiptPath, 'utf8');
      rmSync(receiptPath);
      writeFileSync(receiptPath, receipts, { mode: 0o644 });

      expect(isHooksConfigTrusted(projectDir, hostile)).toBe(false);
    });
  });
});

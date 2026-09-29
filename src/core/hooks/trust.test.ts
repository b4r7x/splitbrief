import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { hashHooksConfig } from './trust-digest.js';
import { trustedProjectIdentity } from '../trust/receipt-store.js';
import { isHooksConfigTrusted, markHooksConfigTrusted } from './trust.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const allowScript = 'export default () => ({ kind: "allow" });\n';
const denyScript = 'export default () => ({ kind: "deny" });\n';

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

    it.each([
      ['npm rum check', ['npm', 'rum', 'check']],
      ['yarn check', ['yarn', 'check']],
      ['yarnpkg check', ['yarnpkg', 'check']],
      ['pnpm check', ['pnpm', 'check']],
      ['bun check', ['bun', 'check']],
      ['NPM run check', ['NPM', 'run', 'check']],
      ['timeout 5 npm run check', ['timeout', '5', 'npm', 'run', 'check']],
      ['npx npm run check', ['npx', 'npm', 'run', 'check']],
      ['npx npm@10 run check', ['npx', 'npm@10', 'run', 'check']],
      ['pnpm exec npm run check', ['pnpm', 'exec', 'npm', 'run', 'check']],
      ['npm exec -- yarn check', ['npm', 'exec', '--', 'yarn', 'check']],
    ])('returns false after the package script a %s hook runs changes', (_label, argv) => {
      const [command, ...args] = argv;
      const cfg = { pre_task: [{ command, args }] };
      writeFileSync(
        join(projectDir, 'package.json'),
        JSON.stringify({ scripts: { check: 'exit 0' } }),
      );
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(
        join(projectDir, 'package.json'),
        JSON.stringify({ scripts: { check: 'exit 1' } }),
      );

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    it.each([
      ['npm run check', 'precheck'],
      ['npm run check', 'postcheck'],
      ['npm test', 'pretest'],
      ['yarn check', 'postcheck'],
      ['npm restart', 'stop'],
    ])('returns false after %s runs a changed %s script', (hook, script) => {
      const [command, ...args] = hook.split(' ');
      const cfg = { pre_task: [{ command, args }] };
      const scripts = {
        check: 'exit 0',
        test: 'exit 0',
        precheck: 'exit 0',
        pretest: 'exit 0',
        stop: 'exit 0',
      };
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ scripts }));
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(
        join(projectDir, 'package.json'),
        JSON.stringify({ scripts: { ...scripts, [script]: 'exit 1' } }),
      );

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    it.each([
      ['npm install', ['npm', 'install'], 'preinstall'],
      ['npm i', ['npm', 'i'], 'install'],
      ['npm ci', ['npm', 'ci'], 'postinstall'],
      ['npm add lodash', ['npm', 'add', 'lodash'], 'prepare'],
    ])(
      'returns false after the install lifecycle script a %s hook runs changes',
      (_label, argv, script) => {
        const [command, ...args] = argv;
        const cfg = { pre_task: [{ command, args }] };
        const scripts = {
          preinstall: 'exit 0',
          install: 'exit 0',
          postinstall: 'exit 0',
          prepare: 'exit 0',
        };
        writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ scripts }));
        markHooksConfigTrusted(projectDir, cfg);
        expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

        writeFileSync(
          join(projectDir, 'package.json'),
          JSON.stringify({ scripts: { ...scripts, [script]: 'exit 1' } }),
        );

        expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
      },
    );

    it('returns false after the server.js npm start runs changes', () => {
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ scripts: {} }));
      writeFileSync(join(projectDir, 'server.js'), 'console.log("a");\n');
      const cfg = { pre_task: [{ command: 'npm', args: ['start'] }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(join(projectDir, 'server.js'), 'console.log("b");\n');

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    it('returns false after the file `node check` actually runs changes', () => {
      writeFileSync(join(projectDir, 'check.js'), 'exit 0\n');
      const cfg = { pre_task: [{ command: 'node', args: ['check'] }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(join(projectDir, 'check.js'), 'exit 1\n');

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    it.each([
      ['node check.mjs', 'check.mjs'],
      ['nodemon check.mjs', 'check.mjs'],
      ['python3 check.py', 'check.py'],
      ['npx tsx check.ts', 'check.ts'],
      ['pnpm dlx tsx@4 check.ts', 'check.ts'],
      ['yarn tsx check.ts', 'check.ts'],
      ['NODE check.mjs', 'check.mjs'],
      ['Node check.mjs', 'check.mjs'],
      ['Python3 check.py', 'check.py'],
      ['python3.13 check.py', 'check.py'],
      ['python3.13t check.py', 'check.py'],
      ['pythonw check.py', 'check.py'],
      ['pypy3 check.py', 'check.py'],
      ['perl5.34 check.pl', 'check.pl'],
    ])('returns false after the file that %s runs changes', (hook, file) => {
      const [command, ...args] = hook.split(' ');
      const cfg = { pre_task: [{ command, args }] };
      writeFileSync(join(projectDir, file), 'exit 0\n');
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(join(projectDir, file), 'exit 1\n');

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    it('returns false after only the repo-local executable an interpreter hook names changes', () => {
      writeFileSync(join(projectDir, 'nodemon'), '#!/bin/sh\nexit 0\n');
      writeFileSync(join(projectDir, 'check.mjs'), 'export default () => ({ kind: "allow" });\n');
      const cfg = { pre_task: [{ command: './nodemon', args: ['check.mjs'] }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(join(projectDir, 'nodemon'), '#!/bin/sh\nexit 1\n');

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    it('returns false after only the absolute repo-local executable an interpreter hook names changes', () => {
      const executable = join(projectDir, 'nodemon');
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      writeFileSync(join(projectDir, 'check.mjs'), 'export default () => ({ kind: "allow" });\n');
      const cfg = { pre_task: [{ command: executable, args: ['check.mjs'] }] };
      markHooksConfigTrusted(projectDir, cfg);
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

      writeFileSync(executable, '#!/bin/sh\nexit 1\n');

      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    itUnix(
      'returns false after only the executable a symlinked-directory `..` path actually runs changes',
      () => {
        mkdirSync(join(projectDir, 'other', 'subdir'), { recursive: true });
        writeFileSync(join(projectDir, 'nodemon'), '#!/bin/sh\nexit 0\n');
        writeFileSync(join(projectDir, 'other', 'nodemon'), '#!/bin/sh\nexit 0\n');
        writeFileSync(join(projectDir, 'check.mjs'), 'export default () => ({ kind: "allow" });\n');
        symlinkSync(join('other', 'subdir'), join(projectDir, 'link'));
        const cfg = {
          pre_task: [{ command: `${projectDir}/link/../nodemon`, args: ['check.mjs'] }],
        };
        markHooksConfigTrusted(projectDir, cfg);
        expect(isHooksConfigTrusted(projectDir, cfg)).toBe(true);

        // The kernel walks `link` before collapsing `..`, so this command runs
        // `<projectDir>/other/nodemon`; rewriting it must invalidate the receipt.
        writeFileSync(join(projectDir, 'other', 'nodemon'), '#!/bin/sh\nexit 1\n');

        expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
      },
    );
  });

  describe('a symlinked hook script is not trust-eligible', () => {
    itUnix(
      'never grants trust for a symlinked hook script and ignores a retargeted symlink',
      () => {
        writeFileSync(join(projectDir, 'first.mjs'), allowScript);
        writeFileSync(join(projectDir, 'second.mjs'), denyScript);
        symlinkSync('first.mjs', join(projectDir, 'check.mjs'));
        const cfg = { pre_task: [{ command: 'node', args: ['./check.mjs'] }] };

        // The digest can only record a refusal for a symlink, so a receipt for that refusal would
        // keep authorizing whatever the link points at. No receipt may be written at all.
        markHooksConfigTrusted(projectDir, cfg);
        expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);

        rmSync(join(projectDir, 'check.mjs'));
        symlinkSync('second.mjs', join(projectDir, 'check.mjs'));

        expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
      },
    );

    itUnix('writes no receipt for a symlinked hook target', () => {
      writeFileSync(join(projectDir, 'target.mjs'), allowScript);
      symlinkSync('target.mjs', join(projectDir, 'check.mjs'));
      const cfg = { pre_task: [{ command: 'node', args: ['check.mjs'] }] };

      markHooksConfigTrusted(projectDir, cfg);

      expect(existsSync(join(trustHome.home, '.splitbrief', 'trust', 'hooks.json'))).toBe(false);
    });

    itUnix('ignores a receipt that recorded the refusal digest (legacy grant)', () => {
      writeFileSync(join(projectDir, 'target.mjs'), allowScript);
      symlinkSync('target.mjs', join(projectDir, 'check.mjs'));
      const cfg = { pre_task: [{ command: 'node', args: ['./check.mjs'] }] };
      const receiptPath = join(trustHome.home, '.splitbrief', 'trust', 'hooks.json');
      mkdirSync(join(trustHome.home, '.splitbrief', 'trust'), { recursive: true, mode: 0o700 });
      writeFileSync(
        receiptPath,
        JSON.stringify({
          version: 1,
          receipts: [
            {
              version: 1,
              projectIdentity: trustedProjectIdentity(projectDir),
              configDigest: hashHooksConfig(projectDir, cfg),
              trustedAt: 0,
            },
          ],
        }),
        { mode: 0o600 },
      );

      // The legacy store holds exactly the digest the symlink refusal produces, so
      // the ineligibility check is the only thing that can refuse it.
      expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
    });

    itUnix('never grants trust for a symlinked interpreter target that PATH resolves', () => {
      const binDir = join(projectDir, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(projectDir, 'tool.mjs'), allowScript);
      symlinkSync(join('..', '..', 'tool.mjs'), join(binDir, 'tool'));
      chmodSync(join(projectDir, 'tool.mjs'), 0o755);
      const cfg = { pre_task: [{ command: 'tool' }] };
      const originalPath = process.env['PATH'];
      process.env['PATH'] = binDir;
      try {
        markHooksConfigTrusted(projectDir, cfg);
        expect(isHooksConfigTrusted(projectDir, cfg)).toBe(false);
      } finally {
        process.env['PATH'] = originalPath;
      }
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

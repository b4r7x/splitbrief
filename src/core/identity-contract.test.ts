import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, assert, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { migrateConfig } from './config/load/migrate.js';
import { SPLITBRIEF_IDENTITY } from './identity.js';
import { migrateCommand } from './migration/executor.js';
import { SPLITBRIEF_DIR } from './paths.js';
import { readPackageJson } from './project-meta.js';
import { normalizeLegacyMode } from './schemas/enums.js';

const ROOT = join(import.meta.dirname, '..', '..');
const CLI_ENTRY = join(ROOT, 'src', 'cli.ts');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const REQUIRED_COMMANDS = ['start', 'spec', 'init', 'status', 'resume', 'migrate'] as const;
const IDENTITY_LABELS = [
  'package',
  'bin',
  'commands',
  'migrate-canonical-only',
  'prior-state-ignored',
  'v3',
  'v2',
  'full',
] as const;

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) cleanupTempDir(tempDir);
  tempDir = undefined;
});

describe('SPLITBRIEF identity', () => {
  it('identity contract matrix has exactly 8 labeled cases', async () => {
    const workingRoot = createTempDir('splitbrief-identity');
    tempDir = workingRoot;
    const packageManifest = readPackageJson(ROOT, { throwOnInvalid: true });
    assert(packageManifest, 'package.json is missing');
    expect(SPLITBRIEF_IDENTITY).toEqual({
      displayName: 'SPLITBRIEF',
      slug: 'splitbrief',
      executable: 'splitbrief',
      stateDir: '.splitbrief',
      envPrefix: 'SPLITBRIEF_',
      branchPrefix: 'splitbrief/',
    });

    const cases = [
      {
        label: 'package',
        run: () => {
          expect(packageManifest['name']).toBe(SPLITBRIEF_IDENTITY.slug);
          expect(packageManifest['description']).toContain(SPLITBRIEF_IDENTITY.displayName);
        },
      },
      {
        label: 'bin',
        run: () => {
          expect(packageManifest['bin']).toEqual({
            [SPLITBRIEF_IDENTITY.executable]: './dist/cli.js',
          });
        },
      },
      {
        label: 'commands',
        run: () => {
          const result = spawnSync(TSX, [CLI_ENTRY, '--help'], {
            cwd: ROOT,
            timeout: 60_000,
            encoding: 'utf-8',
          });
          expect(result.status).toBe(0);
          expect(result.stdout).toContain('Usage: splitbrief');
          expect(result.stdout).toContain('SPLITBRIEF');
          for (const command of REQUIRED_COMMANDS) {
            expect(result.stdout).toMatch(new RegExp(`^  ${command}(?: |$)`, 'm'));
          }
        },
      },
      {
        label: 'migrate-canonical-only',
        run: async () => {
          const projectDir = join(workingRoot, 'canonical');
          const currentDir = join(projectDir, SPLITBRIEF_DIR, 'current');
          mkdirSync(currentDir, { recursive: true });
          writeFileSync(join(currentDir, 'state.json'), '[]');

          const result = await migrateCommand(projectDir);

          expect(result).toMatchObject({ status: 'skipped', sourceDir: currentDir });
          expect(existsSync(currentDir)).toBe(true);
        },
      },
      {
        label: 'prior-state-ignored',
        run: async () => {
          const projectDir = join(workingRoot, 'prior-only');
          const priorStateDirs = [
            '.diptych', // brand-contract-negative
            '.tiny-spec', // brand-contract-negative
          ] as const;
          mkdirSync(projectDir, { recursive: true });
          for (const stateDir of priorStateDirs) {
            mkdirSync(join(projectDir, stateDir, 'current'), { recursive: true });
          }

          await expect(migrateCommand(projectDir)).resolves.toEqual({ status: 'not-needed' });
          for (const stateDir of priorStateDirs) {
            expect(existsSync(join(projectDir, stateDir, 'current'))).toBe(true);
          }
          expect(existsSync(join(projectDir, SPLITBRIEF_DIR))).toBe(false);
        },
      },
      {
        label: 'v3',
        run: () => {
          const config = {
            version: 3,
            planner: { kind: 'cli', tool: 'claude-code' },
            implementer: { kind: 'agent', command: 'local-implementer' },
          };
          expect(migrateConfig(config)).toEqual(config);
        },
      },
      {
        label: 'v2',
        run: () => {
          expect(
            migrateConfig({
              version: 2,
              planner: { kind: 'cli', tool: 'claude-code' },
              implementer: { kind: 'api', provider: 'ollama' },
            }),
          ).toMatchObject({ version: 3 });
        },
      },
      {
        label: 'full',
        run: () => {
          expect(normalizeLegacyMode('full')).toBe('speckit');
        },
      },
    ] satisfies ReadonlyArray<{
      label: (typeof IDENTITY_LABELS)[number];
      run: () => void | Promise<void>;
    }>;

    expect(cases).toHaveLength(8);
    expect(cases.map(({ label }) => label)).toEqual(IDENTITY_LABELS);

    for (const contractCase of cases) {
      await contractCase.run();
    }
  }, 60_000);
});

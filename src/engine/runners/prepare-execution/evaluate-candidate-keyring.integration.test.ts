import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  CODEX_VERSION_LINES,
  installToolShim,
  signInCodexShim,
} from '#testing/helpers/tool-shim.js';
import { detectRunnerEvidence } from '../../detection/runner-evidence/detect.js';
import { evaluateCandidate } from './evaluate-candidate.js';
import type { RunnerCandidate } from './runner-candidates.js';
import type { PreparationContext } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.push(directory);
  return directory;
}

function notCalled(name: string): () => never {
  return () => {
    throw new Error(`${name} is not part of candidate evaluation`);
  };
}

describe('evaluateCandidate on a Codex host that keeps its sign-in in the keyring', () => {
  it.each(['keyring', 'auto'])(
    'blocks the start with the keyring sign-in check (%s store)',
    async (store) => {
      const home = tempDir('evaluate-candidate-keyring-home');
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(
        join(home, '.codex', 'config.toml'),
        `cli_auth_credentials_store = "${store}"\n`,
      );
      vi.stubEnv('HOME', home);
      vi.stubEnv('CODEX_HOME', '');
      vi.stubEnv('OPENAI_API_KEY', '');
      const projectDir = tempDir('evaluate-candidate-keyring-project');
      const shimDir = tempDir('evaluate-candidate-keyring-codex');
      const executable = await installToolShim(
        shimDir,
        'codex',
        signInCodexShim({ argvLog: join(shimDir, 'argv.log'), versionLines: CODEX_VERSION_LINES }),
      );
      const config = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'gpt-6-mini' } });
      const candidate: RunnerCandidate = {
        slot: { role: 'planner' },
        runner: config.planner,
        trustLabel: 'planner',
      };
      const context: PreparationContext = {
        projectDir,
        config,
        policy: {
          purpose: 'new-workflow',
          interaction: 'headless',
          unverifiedAuth: 'denied',
          allowRepoRunners: false,
          allowHooks: true,
        },
        preparationId: 'preparation-1',
        signal: new AbortController().signal,
        nativeTrustViolations: new Set(),
        routeCatalogs: new Map(),
        versionProbes: new Map(),
        deps: {
          detectRunnerEvidence: (options) =>
            detectRunnerEvidence({
              ...options,
              resolveExecutable: async () => executable,
            }),
          collectReadiness: notCalled('collectReadiness'),
          collectArgVectorPreflightChecks: notCalled('collectArgVectorPreflightChecks'),
          probeRunnerAvailability: notCalled('probeRunnerAvailability'),
          prepareCustomRunnerAdmission: notCalled('prepareCustomRunnerAdmission'),
          resolveCliExecutableAliases: notCalled('resolveCliExecutableAliases'),
          prepareNewSession: notCalled('prepareNewSession'),
          reactivateExistingSession: notCalled('reactivateExistingSession'),
          newPreparationId: () => 'preparation-1',
        },
      };

      const result = await evaluateCandidate(candidate, context);

      expect(result.kind).toBe('blocked');
      if (result.kind !== 'blocked') return;
      expect(result.check).toMatchObject({
        severity: 'blocker',
        details: expect.arrayContaining([
          'OpenAI Codex CLI keeps its sign-in in the system keyring, which a run cannot reach.',
        ]),
        fix: 'Set cli_auth_credentials_store = "file" in config.toml and run codex login again, then run `splitbrief doctor` again.',
        runnerCause: { tool: 'codex', cause: 'unauthenticated' },
      });
    },
  );
});

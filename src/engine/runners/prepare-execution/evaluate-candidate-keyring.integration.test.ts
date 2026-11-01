import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { detectRunnerEvidence } from '../../detection/runner-evidence.js';
import type { CliProbeContract } from '../cli-tools/contract.js';
import { resolveCustomExecutable } from '../resolve-cli-executable.js';
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

/** The real node binary with the digest-bound identity the start gate trusts. */
async function nodeExecutable(projectDir: string) {
  const resolved = await resolveCustomExecutable({
    command: 'node',
    projectDir,
    pathEnv: process.env.PATH,
    pathExt: '',
  });
  if (resolved.kind !== 'resolved') throw new Error('Node executable did not resolve');
  return resolved.executable;
}

/** A Codex stand-in at the tested version whose status command reports a sign-in. */
function codexProbe(): CliProbeContract {
  const command = (script: string) =>
    ({
      command: ['node', '-e', script] as const,
      cwd: 'neutral' as const,
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    }) as const;
  const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
  const version = command(`console.log('codex ${testedVersion}')`);
  const auth = command("console.log('verified')");
  return {
    version,
    auth,
    declared: {
      kind: 'declared',
      version: {
        ...version,
        kind: 'version',
        parse: () => ({ kind: 'success', value: testedVersion }),
      },
      auth: { ...auth, kind: 'auth-status', parse: () => 'verified' },
      catalog: { kind: 'not-run' },
    },
  };
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
      const executable = await nodeExecutable(projectDir);
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
        deps: {
          detectRunnerEvidence: (options) =>
            detectRunnerEvidence({
              ...options,
              resolveExecutable: async () => executable,
              lookupProbe: () => codexProbe(),
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
        fix: 'Set cli_auth_credentials_store = "file" in config.toml and run codex login again, or use OPENAI_API_KEY, then run `splitbrief doctor` again.',
        runnerCause: { tool: 'codex', cause: 'unauthenticated' },
      });
    },
  );
});

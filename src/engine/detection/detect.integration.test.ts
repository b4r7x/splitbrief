import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freezeProbeDeadlines } from '#testing/helpers/fake-timers.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { stubSignInHome } from '#testing/helpers/sign-in-home.js';
import {
  CODEX_VERSION_LINES,
  installToolShim,
  signInCodexShim,
} from '#testing/helpers/tool-shim.js';
import type { CliAuthState } from '../../core/discovery/detection/tool.js';
import { CLI_TOOL_CATALOG, LISTED_CLI_TOOL_IDS } from '../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../core/runners/cli-tool/types.js';
import { error } from '../../utils/error.js';
import { detectAvailableCliReadiness, detectAvailableCliTools } from './detect.js';
import { detectRunnerEvidence } from './runner-evidence/detect.js';

/**
 * An `opencode` at its tested release whose credential listing prints `listing`, or exits 1 when
 * `listing` is undefined.
 */
function opencodeShim(listing: string | undefined): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' 'opencode ${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "auth" ] && [ "$2" = "list" ]; then',
    ...(listing === undefined
      ? ['  exit 1']
      : [`  printf '%b' ${JSON.stringify(listing)}`, '  exit 0']),
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

freezeProbeDeadlines();

describe('legacy CLI detection presentation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(platform !== 'win32').each([
    ['detectAvailableCliTools', detectAvailableCliTools],
    ['detectAvailableCliReadiness', detectAvailableCliReadiness],
  ] as const)(
    '%s looks up each listed CLI and reports the probe auth of the installed one',
    async (_name, detect) => {
      await withTempDir('detect-listed-probe-auth', async (directory) => {
        const asked = new Set<string>();
        const argvLog = join(directory, 'argv.log');
        const shim = await installToolShim(
          directory,
          'codex',
          signInCodexShim({ argvLog, versionLines: CODEX_VERSION_LINES }),
        );
        await stubSignInHome(join(directory, 'home'), ['codex']);

        const results: readonly Readonly<{ tool: CliToolId; auth: CliAuthState }>[] = await detect({
          projectDir: '/neutral/project',
          resolveExecutable: async ({ command }) => {
            asked.add(command);
            if (command === 'codex') return shim;
            throw error('cli-executable-unavailable', 'not installed');
          },
          now: () => 1_700_000_000_000,
        });

        expect(results.map(({ tool, auth }) => ({ tool, auth }))).toEqual(
          LISTED_CLI_TOOL_IDS.map((tool) => ({
            tool,
            auth: tool === 'codex' ? 'authenticated' : 'not-checked',
          })),
        );
        for (const tool of LISTED_CLI_TOOL_IDS) {
          expect(asked).toContain(CLI_TOOL_CATALOG[tool].executableAliases[0]);
        }
        expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
          '--version',
          'login status',
        ]);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'keeps an unreadable credential oracle listing of a tool probed on its catalog channel',
    async () => {
      await withTempDir('detect-unreadable-listing', async (directory) => {
        const shim = await installToolShim(directory, 'opencode', opencodeShim(undefined));
        await stubSignInHome(join(directory, 'home'), []);

        const [result] = await detectAvailableCliTools({
          tools: ['opencode'],
          resolveExecutable: async () => shim,
          now: () => 10,
        });

        expect(result).toMatchObject({
          tool: 'opencode',
          providerAuth: { kind: 'unreadable', reason: 'exit-failure' },
        });
      });
    },
  );

  it.runIf(platform !== 'win32').each([
    ['stores no credential', 'Credentials\n0 credentials\n', 'unauthenticated', 'ollama/llama3'],
    ['is signed in', 'Credentials\nanthropic  oauth\n1 credential\n', 'ready', undefined],
  ] as const)(
    'carries the model an OpenCode that %s selects in its own config only when its route decides the seat',
    async (_case, listing, state, selectedModel) => {
      await withTempDir('detect-selected-model', async (directory) => {
        const shim = await installToolShim(directory, 'opencode', opencodeShim(listing));
        await stubSignInHome(join(directory, 'home'), []);
        const configHome = join(directory, 'config');
        await mkdir(join(configHome, 'opencode'), { recursive: true });
        await writeFile(join(configHome, 'opencode', 'opencode.json'), '{"model":"ollama/llama3"}');
        vi.stubEnv('XDG_CONFIG_HOME', configHome);
        const [result] = await detectAvailableCliTools({
          tools: ['opencode'],
          resolveExecutable: async () => shim,
          now: () => 11,
        });

        expect(result?.diagnostic.state).toBe(state);
        expect(result?.selectedModel).toBe(selectedModel);
      });
    },
  );
});

describe('context-bound runner evidence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(platform !== 'win32')(
    'does not promote a metadata-only resolver result to a trusted executable fact',
    async () => {
      await withTempDir('detect-metadata-only', async (directory) => {
        const argvLog = join(directory, 'argv.log');
        const { path, fingerprint } = await installToolShim(
          directory,
          'codex',
          signInCodexShim({ argvLog, versionLines: CODEX_VERSION_LINES }),
        );
        await stubSignInHome(join(directory, 'home'), ['codex']);

        const evidence = await detectRunnerEvidence({
          context: {
            role: 'planner',
            kind: 'cli',
            id: 'codex',
            authChannel: 'session',
            credentialPresent: false,
            configGeneration: 'test-config-generation',
          },
          resolveExecutable: async () => ({ path, fingerprint }),
          now: () => 99,
        });

        expect(evidence.auth).toBe('verified');
        expect(evidence.executable).toEqual({ kind: 'unknown' });
      });
    },
  );
});

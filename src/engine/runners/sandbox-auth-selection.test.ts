import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import type { CliAuthChannelId } from '../../core/runners/cli-tool-catalog.js';
import { detectRunnerEvidence } from '../detection/runner-evidence.js';
import { resolveCliExecutable } from './resolve-cli-executable.js';
import { createRunnerSandboxEnv } from './sandbox-env.js';

const itUnix = it.runIf(process.platform !== 'win32');
const SESSION_TOKEN = 'codex-session-selection-canary';
const API_KEY = 'sk-codex-api-selection-canary';

const originalEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

type Staged = Readonly<{ apiKey: string; session: 'bridged' | 'none' }>;

/**
 * A `codex` that records, per invocation, which of the two competing
 * credentials its staged environment handed it, then answers like the tool:
 * logged in when it holds either one, and a one-model catalog.
 */
async function installCodexShim(root: string, logDir: string) {
  const directory = join(root, 'bin');
  await mkdir(directory);
  const shim = join(directory, 'codex');
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      `tag=$(printf '%s' "$*" | tr ' ' '_')`,
      'if [ -f "$HOME/.codex/auth.json" ]; then session=bridged; else session=none; fi',
      `printf '%s\\n%s\\n' "\${OPENAI_API_KEY:-unset}" "$session" > ${JSON.stringify(logDir)}/"$tag"`,
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.146.0"; exit 0; fi',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      '  if [ -n "$OPENAI_API_KEY" ] || [ "$session" = bridged ]; then echo "Logged in"; exit 0; fi',
      '  echo "Not logged in" >&2; exit 1',
      'fi',
      'if [ "$1" = "debug" ] && [ "$2" = "models" ]; then',
      `  echo '{"models":[{"slug":"gpt-5.2-codex"}]}'; exit 0`,
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(shim, 0o755);
  return resolveCliExecutable({ command: shim, projectDir: join(root, 'project') });
}

async function stagedBy(logDir: string, tag: string): Promise<Staged | undefined> {
  const entries = await readdir(logDir);
  if (!entries.includes(tag)) return undefined;
  const [apiKey = '', session = ''] = (await readFile(join(logDir, tag), 'utf8')).split('\n');
  return { apiKey, session: session === 'bridged' ? 'bridged' : 'none' };
}

function codexContext(authChannel: CliAuthChannelId): RunnerDiscoveryContext {
  return {
    role: 'implementer',
    kind: 'cli',
    id: 'codex',
    authChannel,
    credentialPresent: false,
    configGeneration: 'auth-selection-generation',
  };
}

async function withCodexHost(
  credentials: Readonly<{ session: boolean; apiKey: boolean }>,
  body: (paths: Readonly<{ root: string; hostHome: string; logDir: string }>) => Promise<void>,
): Promise<void> {
  await withTempDir('sandbox-auth-selection', async (root) => {
    const hostHome = join(root, 'host-home');
    const logDir = join(root, 'log');
    await mkdir(join(hostHome, '.codex'), { recursive: true });
    await mkdir(logDir);
    if (credentials.session) {
      await writeFile(
        join(hostHome, '.codex', 'auth.json'),
        JSON.stringify({ token: SESSION_TOKEN }),
      );
    }
    setEnv('HOME', hostHome);
    setEnv('OPENAI_API_KEY', credentials.apiKey ? API_KEY : undefined);
    await body({ root, hostHome, logDir });
  });
}

describe('one auth selection for readiness, catalog and dispatch', () => {
  itUnix.each([
    ['session', { apiKey: 'unset', session: 'bridged' }],
    ['api-key', { apiKey: API_KEY, session: 'none' }],
  ] as const)(
    'hands the %s channel only its own credential in the auth probe, the catalog probe and the spawn',
    async (channel, expected) => {
      await withCodexHost({ session: true, apiKey: true }, async ({ root, logDir }) => {
        const shim = await installCodexShim(root, logDir);

        const evidence = await detectRunnerEvidence({
          context: codexContext(channel),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          projectDir: join(root, 'project'),
        });
        const dispatch = await createRunnerSandboxEnv(
          join(root, 'project'),
          { kind: 'cli', tool: 'codex', authChannel: channel },
          'implementer',
        );

        expect(evidence.auth).toBe('verified');
        expect(evidence.catalog).toMatchObject({ kind: 'success' });
        expect(await stagedBy(logDir, 'login_status')).toEqual(expected);
        expect(await stagedBy(logDir, 'debug_models')).toEqual(expected);
        const dispatchHome = String(dispatch.HOME);
        const dispatchSession = (await readdir(join(dispatchHome, '.codex')).catch(() => []))
          .length;
        expect({
          apiKey: dispatch.OPENAI_API_KEY ?? 'unset',
          session: dispatchSession > 0 ? 'bridged' : 'none',
        }).toEqual(expected);
      });
    },
    60_000,
  );

  itUnix.each([
    ['api-key', { session: true, apiKey: false }],
    ['session', { session: false, apiKey: true }],
  ] as const)(
    'fails the %s channel when only the competing credential exists, without running either probe',
    async (channel, credentials) => {
      await withCodexHost(credentials, async ({ root, logDir }) => {
        const shim = await installCodexShim(root, logDir);

        const evidence = await detectRunnerEvidence({
          context: codexContext(channel),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          projectDir: join(root, 'project'),
        });

        expect(evidence.auth).toBe('missing');
        expect(evidence.catalog).toEqual({ kind: 'missing-credential' });
        expect(await stagedBy(logDir, 'login_status')).toBeUndefined();
        expect(await stagedBy(logDir, 'debug_models')).toBeUndefined();
      });
    },
    60_000,
  );

  itUnix(
    'leaves the shared host login untouched across probes and dispatch on either channel',
    async () => {
      await withCodexHost({ session: true, apiKey: true }, async ({ root, hostHome, logDir }) => {
        const shim = await installCodexShim(root, logDir);
        const loginFile = join(hostHome, '.codex', 'auth.json');
        const before = await readFile(loginFile, 'utf8');
        const hostEntries = await readdir(hostHome, { recursive: true });

        for (const channel of ['session', 'api-key'] as const) {
          await detectRunnerEvidence({
            context: codexContext(channel),
            resolveExecutable: async () => shim,
            includeCatalog: true,
            projectDir: join(root, 'project'),
          });
          await createRunnerSandboxEnv(
            join(root, 'project'),
            { kind: 'cli', tool: 'codex', authChannel: channel },
            'implementer',
          );
        }

        expect(await readFile(loginFile, 'utf8')).toBe(before);
        expect(await readdir(hostHome, { recursive: true })).toEqual(hostEntries);
      });
    },
    60_000,
  );
});

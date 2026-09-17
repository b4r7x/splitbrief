import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createProductionDetectionDeps } from './deps.js';
import { cliAuthRemediation } from '../../core/schemas/readiness.js';

const HOST_ENV = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const;

// The admitted-version `agy models` capture: two header lines, then one
// `<id>\t<display name>` row per model.
const MODEL_ROWS = readFileSync(
  join(import.meta.dirname, '../../../testing/fixtures/antigravity/models.txt'),
  'utf8',
)
  .split('\n')
  .filter((line) => line.includes('\t'));
const MODEL_IDS = MODEL_ROWS.map((row) => row.slice(0, row.indexOf('\t')));

type AgyCall = Readonly<{ args: string; home: string; user: string }>;

/**
 * Stands in for `agy` 1.2.2. `models` answers from the recorded capture when
 * signed in and fails like a signed-out account otherwise; every call records
 * its argv and the `HOME`/`USER` it was staged with.
 */
function writeAgyShim(dir: string, signedIn: boolean): string {
  const log = join(dir, 'agy.log');
  const rows = join(dir, 'models.rows');
  writeFileSync(rows, `${MODEL_ROWS.join('\n')}\n`);
  const models = signedIn
    ? `  cat ${JSON.stringify(rows)}\n  exit 0`
    : "  printf '%s\\n' 'not signed in' >&2\n  exit 1";
  const shim = join(dir, 'agy');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `printf '%s|%s|%s\\n' "$*" "$HOME" "\${USER:-}" >> ${JSON.stringify(log)}`,
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' '1.2.2'",
      '  exit 0',
      'fi',
      'if [ "$1" = "models" ]; then',
      models,
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
  return log;
}

function readCalls(log: string): AgyCall[] {
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [args = '', home = '', user = ''] = line.split('|');
      return { args, home, user };
    });
}

describe.runIf(process.platform !== 'win32')('Antigravity session authentication', () => {
  const hostPlatform = process.platform;
  let shimDir: string;
  let hostHome: string;
  let projectDir: string;
  let savedEnv: readonly (readonly [string, string | undefined])[];

  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  beforeEach(() => {
    shimDir = createTempDir('antigravity-auth-shims');
    hostHome = createTempDir('antigravity-auth-home');
    projectDir = createTempDir('antigravity-auth-project');
    savedEnv = HOST_ENV.map((name) => [name, process.env[name]] as const);
    process.env.PATH = shimDir;
    process.env.HOME = hostHome;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    setPlatform(hostPlatform);
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    cleanupTempDir(shimDir);
    cleanupTempDir(hostHome);
    cleanupTempDir(projectDir);
  });

  async function detectAntigravity() {
    const deps = createProductionDetectionDeps({
      config: makeConfig({ planner: { kind: 'cli', tool: 'antigravity' } }),
      projectDir,
    });
    const signal = new AbortController().signal;
    const readiness = await deps.detectAll({ signal });
    const catalogs = await deps.discoverAllCliTools({ mode: 'automatic', signal });
    return {
      auth: readiness.cliTools.find((detection) => detection.tool === 'antigravity')?.auth,
      catalog: catalogs.find((attempt) => attempt.connection.tool === 'antigravity')?.outcome,
    };
  }

  it('verifies a signed-in macOS account and records every model `agy models` lists', async () => {
    setPlatform('darwin');
    const log = writeAgyShim(shimDir, true);

    const { auth, catalog } = await detectAntigravity();

    expect(auth).toBe('authenticated');
    expect(MODEL_IDS).toHaveLength(14);
    expect(catalog?.kind).toBe('success');
    expect(catalog?.kind === 'success' ? catalog.value.map((model) => model.id) : []).toEqual(
      MODEL_IDS,
    );
    // The oracle ran under the host account its keychain resolves through.
    const oracle = readCalls(log).filter((call) => call.args === 'models');
    expect(oracle.length).toBeGreaterThan(0);
    for (const call of oracle) {
      expect(call.home).toBe(hostHome);
      expect(call.user).not.toBe('');
    }
  }, 30_000);

  // `agy models` is both the auth oracle and the model listing, so one discovery
  // pass spawns it once and the catalog is parsed from the oracle's output.
  it.each([
    { signedIn: true, auth: 'authenticated', catalogIds: MODEL_IDS },
    { signedIn: false, auth: 'unauthenticated', catalogIds: undefined },
  ])(
    'spawns `agy models` once per discovery pass (signed in: $signedIn)',
    async ({ signedIn, auth, catalogIds }) => {
      setPlatform('darwin');
      const log = writeAgyShim(shimDir, signedIn);
      const deps = createProductionDetectionDeps({
        config: makeConfig({ planner: { kind: 'cli', tool: 'antigravity' } }),
        projectDir,
      });

      const attempts = await deps.discoverAllCliTools({
        mode: 'manual',
        signal: new AbortController().signal,
      });
      const outcome = attempts.find(
        (attempt) => attempt.connection.tool === 'antigravity',
      )?.outcome;

      expect(readCalls(log).filter((call) => call.args === 'models')).toHaveLength(1);
      if (catalogIds === undefined) {
        expect(outcome?.kind).not.toBe('success');
      } else {
        expect(outcome?.kind === 'success' ? outcome.value.map((model) => model.id) : []).toEqual(
          catalogIds,
        );
      }
      const readiness = await deps.detectAll({ signal: new AbortController().signal });
      expect(readiness.cliTools.find((detection) => detection.tool === 'antigravity')?.auth).toBe(
        auth,
      );
    },
    30_000,
  );

  it('gives an unsupported platform no host-account access and claims no session', async () => {
    setPlatform('linux');
    // Signed in on the host: an answer would come only from the host account.
    const log = writeAgyShim(shimDir, true);

    const { auth, catalog } = await detectAntigravity();

    expect(auth).toBe('unknown');
    expect(catalog).toEqual({ kind: 'unsupported' });
    expect(cliAuthRemediation({ tool: 'antigravity', authChannel: 'session' })).toContain(
      'credential on Linux',
    );
    expect(cliAuthRemediation({ tool: 'antigravity', authChannel: 'session' })).toContain(
      'signing in again cannot enable it',
    );
    for (const call of readCalls(log)) {
      expect(call.args).toBe('--version');
      expect(call.home).not.toBe(hostHome);
    }
  }, 30_000);

  it.each(['darwin', 'linux'] as const)(
    'on %s runs only the version and model listing, and writes nothing into the host home',
    async (platform) => {
      setPlatform(platform);
      const log = writeAgyShim(shimDir, true);

      await detectAntigravity();

      expect(new Set(readCalls(log).map((call) => call.args))).toEqual(
        new Set(platform === 'darwin' ? ['--version', 'models'] : ['--version']),
      );
      expect(readdirSync(hostHome)).toEqual([]);
    },
    30_000,
  );
});

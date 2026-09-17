import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../core/schemas/config.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import { createProductionDetectionDeps } from './deps.js';

const STATE_SOURCE_ENV = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const;

function writeShim(dir: string, name: string, lines: readonly string[]): string {
  const argsLog = join(dir, `${name}.args`);
  const executable = join(dir, name);
  writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'args=$(printf \'%s|\' "$@")',
      `printf '%s\\n' "$args" >> ${JSON.stringify(argsLog)}`,
      ...lines,
    ].join('\n'),
    'utf8',
  );
  chmodSync(executable, 0o755);
  return argsLog;
}

function seedSessionState(homeDir: string, relativePath: string): void {
  const target = join(homeDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '{"session":"stub"}\n', 'utf8');
}

describe.runIf(process.platform !== 'win32')('native catalog discovery scope', () => {
  let shimDir: string;
  let homeDir: string;
  let projectDir: string;
  let savedEnv: readonly (readonly [string, string | undefined])[];

  beforeEach(() => {
    shimDir = createTempDir('catalog-scope-shims');
    homeDir = createTempDir('catalog-scope-home');
    projectDir = createTempDir('catalog-scope-project');
    savedEnv = ['PATH', ...STATE_SOURCE_ENV].map((name) => [name, process.env[name]] as const);
    process.env.PATH = shimDir;
    process.env.HOME = homeDir;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    seedSessionState(homeDir, '.local/share/opencode/auth.json');
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    cleanupTempDir(shimDir);
    cleanupTempDir(homeDir);
    cleanupTempDir(projectDir);
  });

  it('carries manual catalog refresh through the production dependency closure', async () => {
    const argsLog = writeShim(shimDir, 'opencode', [
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' '0.5.0'",
      '  exit 0',
      'fi',
      "printf '%s\\n' 'openai/gpt-5.4'",
    ]);

    const deps = createProductionDetectionDeps({
      config: makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }),
      projectDir,
    });
    const attempts = await deps.discoverAllCliTools({
      mode: 'manual',
      signal: new AbortController().signal,
    });

    const opencodeAttempts = attempts.filter((attempt) => attempt.connection.tool === 'opencode');
    expect(opencodeAttempts).toHaveLength(1);
    expect(opencodeAttempts[0]).toEqual(
      expect.objectContaining({
        outcome: { kind: 'success', value: [{ id: 'openai/gpt-5.4', nativeOrder: 0 }] },
      }),
    );
    expect(existsSync(argsLog)).toBe(true);
    expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toContain(
      'models|--verbose|--refresh|',
    );
    expect(
      readFileSync(argsLog, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line === 'models|--verbose|--refresh|'),
    ).toHaveLength(1);
  });

  it('probes each catalog-capable tool once and keeps every provider variant of a duplicated model', async () => {
    writeShim(shimDir, 'codex', [
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' 'codex-cli 0.146.0'",
      '  exit 0',
      'fi',
      'exit 0',
    ]);
    const opencodeArgsLog = writeShim(shimDir, 'opencode', [
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' '1.18.10'",
      '  exit 0',
      'fi',
      'if [ "$1" = "models" ]; then',
      "  printf '%s\\n' 'ollama-cloud/deepseek-v4-flash'",
      "  printf '%s\\n' 'opencode-go/deepseek-v4-flash'",
      '  exit 0',
      'fi',
      'exit 0',
    ]);

    const deps = createProductionDetectionDeps({
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      projectDir,
    });
    const attempts = await deps.discoverAllCliTools({
      mode: 'automatic',
      signal: new AbortController().signal,
    });
    const forTool = (tool: string) =>
      attempts.filter((attempt) => attempt.connection.tool === tool);

    const opencodeAttempts = forTool('opencode');
    expect(opencodeAttempts).toHaveLength(1);
    expect(opencodeAttempts[0]?.outcome).toEqual({
      kind: 'success',
      value: [
        { id: 'ollama-cloud/deepseek-v4-flash', nativeOrder: 0 },
        { id: 'opencode-go/deepseek-v4-flash', nativeOrder: 1 },
      ],
    });
    expect(existsSync(opencodeArgsLog)).toBe(true);
    expect(
      readFileSync(opencodeArgsLog, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line === 'models|--verbose|'),
    ).toHaveLength(1);

    expect(forTool('codex')).toHaveLength(1);
    for (const tool of ['kilo-code', 'copilot']) {
      expect(forTool(tool).map((attempt) => attempt.outcome.kind)).toEqual(['not-run']);
      expect(existsSync(join(shimDir, `${tool}.args`))).toBe(false);
    }
    expect(forTool('claude-code')).toEqual([]);
  });

  it('issues one version probe and at most one catalog probe per installed tool', async () => {
    const versionShim = (name: string, version: string, catalogLines: readonly string[]) =>
      writeShim(shimDir, name, [
        'if [ "$1" = "--version" ]; then',
        `  printf '%s\\n' '${version}'`,
        '  exit 0',
        'fi',
        ...catalogLines,
        'exit 0',
      ]);
    const logs = {
      codex: versionShim('codex', 'codex-cli 0.146.0', []),
      opencode: versionShim('opencode', '1.18.10', ["printf '%s\\n' 'openai/gpt-5.4'"]),
      kilo: versionShim('kilo', '7.0.49', ["printf '%s\\n' 'kilo/openrouter/free'"]),
      cmd: versionShim('cmd', '1.53.0', ["printf '%s\\n' 'deepseek/deepseek-v4-pro   fast'"]),
      'cursor-agent': versionShim('cursor-agent', '2026.09.01-abc1234', [
        "printf '%s\\n' 'gpt-5.4'",
      ]),
      copilot: versionShim('copilot', 'GitHub Copilot CLI 1.0.77.', [
        "printf '%s\\n' 'model: gpt-5.4'",
      ]),
      agy: versionShim('agy', '1.2.2', ["printf '%s\\t%s\\n' 'gemini-3-pro' 'Gemini 3 Pro'"]),
    } as const;

    const deps = createProductionDetectionDeps({
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      projectDir,
    });
    const attempts = await deps.discoverAllCliTools({
      mode: 'automatic',
      signal: new AbortController().signal,
    });

    expect(attempts).toHaveLength(7);
    expect(attempts.map((attempt) => attempt.connection.tool).toSorted()).toEqual([
      'antigravity',
      'codex',
      'command-code',
      'copilot',
      'cursor',
      'kilo-code',
      'opencode',
    ]);
    for (const [name, log] of Object.entries(logs)) {
      const lines = readFileSync(log, 'utf8').trim().split('\n');
      expect(
        lines.filter((line) => line === '--version|'),
        name,
      ).toHaveLength(1);
      const catalogLines = lines.filter(
        (line) =>
          line.startsWith('models|') || line === '--list-models|' || line === 'help|config|',
      );
      expect(catalogLines.length, name).toBeLessThanOrEqual(1);
    }
  });
});

/** A local API seat every role can hold; `model` is exact, never inferred. */
type LocalApiSeat = Extract<PlannerConfig, { kind: 'api' }> & { readonly model: string };

function localSeat(port: number, model: string, apiKey?: string): LocalApiSeat {
  return {
    kind: 'api',
    provider: 'ollama',
    service: 'ollama',
    offering: 'local',
    model,
    apiBase: `http://127.0.0.1:${port}/v1`,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

/**
 * Ollama and LM Studio are still admitted for the implementer role only, so a
 * planner-tier local seat cannot be expressed through `ConfigSchema` yet. The
 * seats are attached to a parsed config directly: this card owns the discovery
 * scope of a configured seat, not its role admission.
 */
function configWithSeats(
  seats: Readonly<{ planner: LocalApiSeat; implementer?: LocalApiSeat; reviewer?: LocalApiSeat }>,
): Config {
  const base = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
  return {
    ...base,
    planner: seats.planner,
    ...(seats.implementer === undefined ? {} : { implementer: seats.implementer }),
    ...(seats.reviewer === undefined ? {} : { reviewer: seats.reviewer }),
  };
}

function tagsUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/tags`;
}

function routeTagsByPort(catalogs: Readonly<Record<number, readonly string[]>>): string[] {
  const requested: string[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    requested.push(url);
    const models = catalogs[Number(new URL(url).port)];
    if (models === undefined || !url.endsWith('/api/tags'))
      return new Response('', { status: 404 });
    return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), {
      status: 200,
    });
  });
  return requested;
}

describe('configured provider catalog scope', () => {
  setupFetchMock();

  let emptyPathDir: string;
  let projectDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    emptyPathDir = createTempDir('seat-scope-path');
    projectDir = createTempDir('seat-scope-project');
    savedPath = process.env.PATH;
    process.env.PATH = emptyPathDir;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    cleanupTempDir(emptyPathDir);
    cleanupTempDir(projectDir);
  });

  const outcomeFor = (
    outcomes: readonly ConfiguredProviderOutcome[],
    role: string,
  ): ConfiguredProviderOutcome | undefined =>
    outcomes.find((entry) => entry.connection.role === role);

  it('probes each configured seat on its own endpoint and attributes every outcome to that seat', async () => {
    const requested = routeTagsByPort({
      11434: ['plan-model:8b'],
      11435: ['build-model:8b'],
      11436: ['review-model:8b'],
    });
    const deps = createProductionDetectionDeps({
      config: configWithSeats({
        planner: localSeat(11434, 'plan-model:8b'),
        implementer: localSeat(11435, 'build-model:8b'),
        reviewer: localSeat(11436, 'review-model:8b'),
      }),
      projectDir,
    });

    const outcomes = (await deps.detectAll({ signal: new AbortController().signal }))
      .configuredProviderOutcomes;
    if (outcomes === undefined) throw new Error('Expected configured provider outcomes.');

    expect(outcomes.map((entry) => entry.connection.role).toSorted()).toEqual([
      'implementer',
      'planner',
      'reviewer',
    ]);
    expect(new Set(outcomes.map((entry) => entry.connection.contextKey)).size).toBe(3);
    expect(outcomeFor(outcomes, 'planner')?.outcome).toMatchObject({
      kind: 'success',
      models: [{ id: 'plan-model:8b' }],
    });
    expect(outcomeFor(outcomes, 'implementer')?.outcome).toMatchObject({
      kind: 'success',
      models: [{ id: 'build-model:8b' }],
    });
    expect(outcomeFor(outcomes, 'reviewer')?.outcome).toMatchObject({
      kind: 'success',
      models: [{ id: 'review-model:8b' }],
    });
    expect(requested.filter((url) => url.endsWith('/api/tags')).toSorted()).toEqual(
      [tagsUrl(11434), tagsUrl(11435), tagsUrl(11436)].toSorted(),
    );
  });

  it('reuses the planner request for an absent reviewer and still publishes an exact reviewer outcome', async () => {
    const requested = routeTagsByPort({ 11434: ['plan-model:8b'] });
    const deps = createProductionDetectionDeps({
      config: configWithSeats({ planner: localSeat(11434, 'plan-model:8b') }),
      projectDir,
    });

    const outcomes = (await deps.detectAll({ signal: new AbortController().signal }))
      .configuredProviderOutcomes;
    if (outcomes === undefined) throw new Error('Expected configured provider outcomes.');

    expect(outcomes.map((entry) => entry.connection.role).toSorted()).toEqual([
      'planner',
      'reviewer',
    ]);
    expect(requested.filter((url) => url === tagsUrl(11434))).toHaveLength(1);

    const planner = outcomeFor(outcomes, 'planner');
    const reviewer = outcomeFor(outcomes, 'reviewer');
    expect(reviewer?.outcome).toEqual(planner?.outcome);
    expect(reviewer?.outcome).not.toBe(planner?.outcome);
    expect(reviewer?.connection.contextKey).not.toBe(planner?.connection.contextKey);
  });

  it('keeps a rejected reviewer credential unpublished and off the planner catalog', async () => {
    routeTagsByPort({ 11434: ['plan-model:8b'], 11436: ['review-model:8b'] });
    const credential = 'reviewer-inline-credential-canary';
    const deps = createProductionDetectionDeps({
      config: configWithSeats({
        planner: localSeat(11434, 'plan-model:8b'),
        reviewer: localSeat(11436, 'review-model:8b', credential),
      }),
      projectDir,
    });

    const outcomes = (await deps.detectAll({ signal: new AbortController().signal }))
      .configuredProviderOutcomes;
    if (outcomes === undefined) throw new Error('Expected configured provider outcomes.');

    const published = JSON.stringify({ outcomes, sourceContexts: deps.sourceContexts });
    expect(published).not.toContain(credential);
    // Ollama admits no inline credential, so the reviewer probe fails on its own
    // connection: it never inherits the planner's catalog.
    expect(outcomeFor(outcomes, 'reviewer')?.outcome.kind).toBe('failed');
    expect(outcomeFor(outcomes, 'planner')?.outcome).toMatchObject({
      kind: 'success',
      models: [{ id: 'plan-model:8b' }],
    });
  });

  it('changes every discovery source context when the reviewer connection changes', () => {
    const planner = localSeat(11434, 'plan-model:8b');
    const sourceContextsFor = (reviewer: LocalApiSeat) =>
      createProductionDetectionDeps({
        config: configWithSeats({ planner, reviewer }),
        projectDir,
      }).sourceContexts;

    const first = sourceContextsFor(localSeat(11436, 'review-model:8b'));
    const movedEndpoint = sourceContextsFor(localSeat(11437, 'review-model:8b'));
    const addedCredential = sourceContextsFor(
      localSeat(11436, 'review-model:8b', 'env:REVIEWER_API_KEY'),
    );

    for (const source of ['readiness', 'modelsDev', 'cliModels'] as const) {
      expect(new Set([first[source], movedEndpoint[source], addedCredential[source]]).size).toBe(3);
    }
    expect(new Set(Object.values(first)).size).toBe(4);
  });
});

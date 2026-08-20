import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-config.js';
import type { CliAuthChannelId, CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import type { ScopedCliCatalogAttempt } from '../detection/cli-catalog-outcomes.js';
import { discoverAllCliTools } from './discovery.js';

let shimDir: string;
let projectDir: string;
let originalPath: string | undefined;
let originalOpenAiApiKey: string | undefined;

const VERSION_BY_COMMAND: Readonly<Record<string, string>> = {
  codex: '0.40.0',
  aider: '0.86.0',
  opencode: '0.5.0',
  kilo: '0.1.0',
};

function defaultVersionOutput(command: string, version: string): string {
  switch (command) {
    case 'codex':
      return `codex-cli ${version}`;
    case 'opencode':
    case 'kilo':
      return version;
    default:
      return `${command} ${version}`;
  }
}

function installShim(command: string, body: string): void {
  const shimPath = join(shimDir, command);
  writeFileSync(shimPath, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
}

function installCatalogShim(
  command: string,
  input: Readonly<{
    logPath: string;
    version?: string | undefined;
    versionOutput?: string | undefined;
    catalog?: string | undefined;
    cwdLogPath?: string | undefined;
    environmentLogPath?: string | undefined;
    driftAfterCatalog?: boolean | undefined;
  }>,
): void {
  const version = input.version ?? VERSION_BY_COMMAND[command] ?? '0.0.0';
  const versionOutput = input.versionOutput ?? defaultVersionOutput(command, version);
  const catalog = input.catalog ?? '';
  installShim(
    command,
    [
      ...(input.cwdLogPath === undefined ? [] : [`pwd > ${JSON.stringify(input.cwdLogPath)}`]),
      ...(input.environmentLogPath === undefined
        ? []
        : [
            `printf '%s\\n' "${'$'}PATH" > ${JSON.stringify(input.environmentLogPath)}`,
            `printf '%s\\n' "${'$'}{DISCOVERY_SECRET-unset}" >> ${JSON.stringify(input.environmentLogPath)}`,
            `printf '%s\\n' "${'$'}{OPENAI_API_KEY-unset}" >> ${JSON.stringify(input.environmentLogPath)}`,
          ]),
      `printf '%s|' "${'$'}@" >> ${JSON.stringify(input.logPath)}`,
      `printf '\\n' >> ${JSON.stringify(input.logPath)}`,
      'if [ "$1" = "--version" ]; then',
      `  printf '%s\\n' ${JSON.stringify(versionOutput)}`,
      '  exit 0',
      'fi',
      `printf '%b\\n' ${JSON.stringify(catalog)}`,
      ...(input.driftAfterCatalog
        ? [
            'if [ "$1" = "debug" ] && [ "$2" = "models" ]; then',
            '  printf "\\n# executable drift after catalog\\n" >> "$0"',
            'fi',
          ]
        : []),
    ].join('\n'),
  );
}

function installHangingShim(command: string, pidFile: string): void {
  installShim(command, [`echo $$ > ${JSON.stringify(pidFile)}`, 'exec /bin/sleep 30'].join('\n'));
}

function loggedArgs(logPath: string): string[] {
  return existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

function context(
  tool: CliToolId,
  role: 'planner' | 'implementer' = 'planner',
  authChannel?: CliAuthChannelId,
): RunnerDiscoveryContext {
  return {
    role,
    kind: 'cli',
    id: tool,
    credentialPresent: false,
    configGeneration: `catalog-${role}-${tool}`,
    ...(authChannel === undefined ? {} : { authChannel }),
  };
}

function nativeContexts(): readonly RunnerDiscoveryContext[] {
  return [context('codex'), context('aider'), context('opencode'), context('kilo-code')];
}

async function exactResolver(command: string, projectDir: string) {
  return resolveCliExecutable(join(shimDir, command), projectDir);
}

function attemptFor(
  attempts: readonly ScopedCliCatalogAttempt[],
  tool: CliToolId,
  role: 'planner' | 'implementer' = 'planner',
): ScopedCliCatalogAttempt | undefined {
  return attempts.find(
    (attempt) => attempt.connection.tool === tool && attempt.connection.role === role,
  );
}

function successfulModels(
  attempts: readonly ScopedCliCatalogAttempt[],
  tool: CliToolId,
): readonly { id: string }[] | undefined {
  const outcome = attemptFor(attempts, tool)?.outcome;
  return outcome?.kind === 'success' ? outcome.value : undefined;
}

beforeEach(() => {
  shimDir = createTempDir('discovery-shim');
  projectDir = createTempDir('discovery-project');
  originalPath = process.env.PATH;
  originalOpenAiApiKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  delete process.env.DISCOVERY_SECRET;
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

describe.runIf(process.platform !== 'win32')('discoverAllCliTools', () => {
  it('uses the canonical exact-executable path and preserves native parser metadata', async () => {
    const codexLog = join(shimDir, 'codex.args');
    const aiderLog = join(shimDir, 'aider.args');
    const opencodeLog = join(shimDir, 'opencode.args');
    const kiloLog = join(shimDir, 'kilo.args');
    const opencodeCwdLog = join(shimDir, 'opencode.cwd');
    installCatalogShim('codex', {
      logPath: codexLog,
      catalog: JSON.stringify({
        models: [
          {
            id: 'gpt-5.6-sol',
            display_name: 'GPT-5.6 Sol',
            is_default: true,
            hidden: false,
            supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
          },
        ],
      }),
    });
    installCatalogShim('aider', {
      logPath: aiderLog,
      catalog: ['Available Models', '- GPT-4o (openai/gpt-4o)'].join('\n'),
    });
    installCatalogShim('opencode', {
      logPath: opencodeLog,
      catalog: ['Models', 'anthropic/claude-3-5-sonnet', 'openai/gpt-4o'].join('\n'),
      cwdLogPath: opencodeCwdLog,
    });
    installCatalogShim('kilo', {
      logPath: kiloLog,
      catalog: ['kilo/anthropic/claude-3-5-sonnet', 'kilo/openai/gpt-4o'].join('\n'),
    });

    const attempts = await discoverAllCliTools({
      contexts: nativeContexts(),
      projectDir,
      resolveExecutable: exactResolver,
    });

    expect(successfulModels(attempts, 'codex')).toEqual([
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        nativeOrder: 0,
        nativeDefault: true,
        nativeHidden: false,
        nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        supportsReasoning: true,
      },
    ]);
    expect(attemptFor(attempts, 'aider')?.outcome).toEqual({
      kind: 'success',
      value: [{ id: 'openai/gpt-4o', nativeOrder: 0 }],
    });
    expect(successfulModels(attempts, 'opencode')?.map((model) => model.id)).toEqual([
      'anthropic/claude-3-5-sonnet',
      'openai/gpt-4o',
    ]);
    expect(successfulModels(attempts, 'kilo-code')?.map((model) => model.id)).toEqual([
      'kilo/anthropic/claude-3-5-sonnet',
      'kilo/openai/gpt-4o',
    ]);
    expect(loggedArgs(codexLog)).toEqual(['--version|', 'debug|models|--bundled|']);
    expect(loggedArgs(aiderLog)).toEqual(['--version|', '--list-models||']);
    expect(loggedArgs(opencodeLog)).toEqual(['--version|', 'models|']);
    expect(loggedArgs(kiloLog)).toEqual(['--version|', 'models|']);
    const catalogCwd = readFileSync(opencodeCwdLog, 'utf8').trim();
    expect(catalogCwd).not.toBe(shimDir);
    expect(existsSync(catalogCwd)).toBe(false);
    expect(JSON.stringify(attempts)).not.toContain(shimDir);
  });

  it.each([
    ['codex', '0.39.9'],
    ['aider', '0.85.9'],
    ['opencode', '0.4.9'],
    ['kilo-code', '0.0.9'],
  ] as const)(
    'does not spawn a %s catalog outside canonical compatibility',
    async (tool, version) => {
      const command = tool === 'kilo-code' ? 'kilo' : tool;
      const logPath = join(shimDir, `${command}.args`);
      installCatalogShim(command, {
        logPath,
        version,
        catalog: tool === 'codex' ? JSON.stringify({ models: [{ id: 'must-not-run' }] }) : 'x/y',
      });

      const attempts = await discoverAllCliTools({
        contexts: [context(tool)],
        projectDir,
        resolveExecutable: exactResolver,
      });

      expect(attemptFor(attempts, tool)?.outcome).toEqual({ kind: 'unsupported' });
      expect(loggedArgs(logPath)).toEqual(['--version|']);
    },
  );

  it('admits a codex catalog for a version newer than the tested release', async () => {
    const logPath = join(shimDir, 'codex.args');
    installCatalogShim('codex', {
      logPath,
      version: '0.146.0',
      catalog: JSON.stringify({ models: [{ id: 'gpt-5.3-codex' }] }),
    });

    const attempts = await discoverAllCliTools({
      contexts: [context('codex')],
      projectDir,
      resolveExecutable: exactResolver,
    });

    expect(attemptFor(attempts, 'codex')?.outcome.kind).not.toBe('unsupported');
    expect(loggedArgs(logPath)).toEqual(['--version|', 'debug|models|--bundled|']);
  });

  it.each([
    ['codex', '0.40.0-rc.1'],
    ['aider', 'broken-version'],
    ['opencode', '0.5.0-rc.1'],
    ['kilo-code', 'not-a-version'],
  ] as const)(
    'does not spawn a %s catalog for prerelease or malformed version evidence',
    async (tool, version) => {
      const command = tool === 'kilo-code' ? 'kilo' : tool;
      const logPath = join(shimDir, `${command}.args`);
      installCatalogShim(command, { logPath, version, catalog: 'must-not-run/model' });

      await discoverAllCliTools({
        contexts: [context(tool)],
        projectDir,
        resolveExecutable: exactResolver,
      });

      expect(loggedArgs(logPath)).toEqual(['--version|']);
    },
  );

  for (const tool of ['codex', 'aider', 'opencode', 'kilo-code'] as const) {
    const command = tool === 'kilo-code' ? 'kilo' : tool;
    const versionLabel = tool === 'codex' ? 'codex-cli' : tool === 'aider' ? 'aider' : undefined;
    const canonicalVersionOutput = (version: string) =>
      versionLabel === undefined ? version : `${versionLabel} ${version}`;
    const admittedVersion =
      tool === 'codex'
        ? '0.40.0'
        : tool === 'aider'
          ? '0.86.0'
          : tool === 'opencode'
            ? '0.5.0'
            : '0.1.0';
    const catalogArgv =
      tool === 'codex'
        ? 'debug|models|--bundled|'
        : tool === 'aider'
          ? '--list-models||'
          : 'models|';
    const catalog =
      tool === 'codex'
        ? JSON.stringify({ models: [{ id: 'admitted-model' }] })
        : tool === 'aider'
          ? '- OpenAI (openai/admitted-model)'
          : tool === 'kilo-code'
            ? 'kilo/provider/admitted-model'
            : 'provider/admitted-model';

    for (const versionCase of [
      {
        name: 'one canonical selected-tool version',
        output: canonicalVersionOutput(admittedVersion),
        admitted: true,
      },
      {
        name: 'a dependency-only admitted-looking version',
        output: `node ${admittedVersion}`,
        admitted: false,
      },
      {
        name: 'an unsupported dependency alongside an admitted selected-tool version',
        output: `node 99.0.0\n${canonicalVersionOutput(admittedVersion)}`,
        admitted: false,
      },
      {
        name: 'two conflicting selected-tool versions',
        output:
          versionLabel === undefined
            ? `${admittedVersion}\n99.0.0`
            : `${versionLabel} ${admittedVersion}\n${versionLabel} 99.0.0`,
        admitted: false,
      },
      {
        name: 'a selected-tool prerelease',
        output:
          versionLabel === undefined
            ? `${admittedVersion}-rc.1`
            : `${versionLabel} ${admittedVersion}-rc.1`,
        admitted: false,
      },
      {
        name: 'a malformed selected-tool version',
        output: versionLabel === undefined ? 'version unknown' : `${versionLabel} version unknown`,
        admitted: false,
      },
    ] as const) {
      it(`${tool} spawns its catalog only for ${versionCase.name}`, async () => {
        const logPath = join(shimDir, `${command}.${versionCase.name.replaceAll(' ', '-')}.args`);
        installCatalogShim(command, {
          logPath,
          versionOutput: versionCase.output,
          catalog,
        });

        const attempts = await discoverAllCliTools({
          contexts: [context(tool)],
          projectDir,
          resolveExecutable: exactResolver,
        });

        expect(attemptFor(attempts, tool)?.outcome.kind).toBe(
          versionCase.admitted ? 'success' : 'unsupported',
        );
        expect(loggedArgs(logPath)).toEqual([
          '--version|',
          ...(versionCase.admitted ? [catalogArgv] : []),
        ]);
      });
    }
  }

  it('reports a malformed catalog without inventing an empty success', async () => {
    const logPath = join(shimDir, 'codex.args');
    installCatalogShim('codex', { logPath, catalog: 'Usage: codex debug models [OPTIONS]' });

    const attempts = await discoverAllCliTools({
      contexts: [context('codex')],
      projectDir,
      resolveExecutable: exactResolver,
    });

    expect(attemptFor(attempts, 'codex')?.outcome).toEqual({ kind: 'malformed' });
    expect(loggedArgs(logPath)).toEqual(['--version|', 'debug|models|--bundled|']);
  });

  it('allows fixed refresh argv only on manual OpenCode and Kilo discovery', async () => {
    const codexLog = join(shimDir, 'codex.args');
    const aiderLog = join(shimDir, 'aider.args');
    const opencodeLog = join(shimDir, 'opencode.args');
    const kiloLog = join(shimDir, 'kilo.args');
    installCatalogShim('codex', { logPath: codexLog, catalog: JSON.stringify({ models: [] }) });
    installCatalogShim('aider', { logPath: aiderLog, catalog: '' });
    installCatalogShim('opencode', { logPath: opencodeLog, catalog: '' });
    installCatalogShim('kilo', { logPath: kiloLog, catalog: '' });

    await discoverAllCliTools({
      contexts: nativeContexts(),
      projectDir,
      refresh: 'manual',
      resolveExecutable: exactResolver,
    });

    expect(loggedArgs(codexLog)).toEqual(['--version|', 'debug|models|--bundled|']);
    expect(loggedArgs(aiderLog)).toEqual(['--version|', '--list-models||']);
    expect(loggedArgs(opencodeLog)).toEqual(['--version|', 'models|--refresh|']);
    expect(loggedArgs(kiloLog)).toEqual(['--version|', 'models|--refresh|']);
  });

  it('uses only the selected channel while keeping ambient secrets and PATH shadows out', async () => {
    const hostileDir = createTempDir('discovery-hostile-shadow');
    const hostileMarker = join(hostileDir, 'executed');
    const environmentLog = join(shimDir, 'environment');
    const exactLog = join(shimDir, 'codex.args');
    try {
      writeFileSync(
        join(hostileDir, 'codex'),
        `#!/bin/sh\ntouch ${JSON.stringify(hostileMarker)}\n`,
        'utf8',
      );
      chmodSync(join(hostileDir, 'codex'), 0o755);
      process.env.PATH = `${hostileDir}:${originalPath ?? ''}`;
      process.env.DISCOVERY_SECRET = 'ambient-secret-must-not-reach-cli';
      process.env.OPENAI_API_KEY = 'selected-channel-secret-canary';
      installCatalogShim('codex', {
        logPath: exactLog,
        catalog: JSON.stringify({ models: [] }),
        environmentLogPath: environmentLog,
      });

      await discoverAllCliTools({
        contexts: [context('codex', 'planner', 'api-key')],
        projectDir,
        resolveExecutable: exactResolver,
      });

      const [path, ambientSecret, selectedSecret] = readFileSync(environmentLog, 'utf8')
        .trimEnd()
        .split('\n');
      expect(existsSync(hostileMarker)).toBe(false);
      expect(path?.split(':')).not.toContain(hostileDir);
      expect(ambientSecret).toBe('unset');
      expect(selectedSecret).toBe('selected-channel-secret-canary');
    } finally {
      cleanupTempDir(hostileDir);
    }
  });

  it('does not publish a catalog when the exact executable drifts during its probe', async () => {
    const logPath = join(shimDir, 'codex.args');
    installCatalogShim('codex', {
      logPath,
      catalog: JSON.stringify({ models: [{ id: 'must-not-publish' }] }),
      driftAfterCatalog: true,
    });

    const attempts = await discoverAllCliTools({
      contexts: [context('codex')],
      projectDir,
      resolveExecutable: exactResolver,
    });

    expect(attemptFor(attempts, 'codex')?.outcome).toEqual({ kind: 'cancelled' });
    expect(loggedArgs(logPath)).toEqual(['--version|', 'debug|models|--bundled|']);
    expect(JSON.stringify(attempts)).not.toContain('must-not-publish');
  });

  it('reaps a cancelled catalog process group', async () => {
    const pidFile = join(shimDir, 'opencode.pid');
    installHangingShim('opencode', pidFile);
    const controller = new AbortController();
    const pending = discoverAllCliTools({
      contexts: [context('opencode')],
      projectDir,
      resolveExecutable: exactResolver,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    });
  }, 5_000);
});

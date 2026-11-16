import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  LISTED_CLI_TOOL_IDS,
} from '../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../core/runners/cli-tool/types.js';
import { createProductionDetectionDeps } from './deps.js';

const HOST_DETECTION_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'COPILOT_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

const SEEDED_SESSION_STATE_PATHS = [
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.config/opencode/auth.json',
  '.copilot/config.json',
  '.config/kilo/auth.json',
  '.config/cursor/auth.json',
  '.commandcode/auth.json',
] as const;

const CLI_VERSION_LABELS: Record<CliToolId, string> = {
  'claude-code': 'claude ',
  codex: 'codex-cli ',
  opencode: '',
  copilot: 'copilot version ',
  'kilo-code': '',
  cursor: '',
  'command-code': '',
  antigravity: '',
};

const CLI_AUTH_STATUS_RESPONSES: Partial<Record<CliToolId, readonly string[]>> = {
  'claude-code': [
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
    `  printf '%s\\n' '{"loggedIn": true}'`,
    '  exit 0',
    'fi',
  ],
  codex: [
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
    "  printf '%s\\n' 'Logged in using ChatGPT'",
    '  exit 0',
    'fi',
  ],
  cursor: [
    'if [ "$1" = "status" ]; then',
    `  printf '%s\\n' '{"loggedIn": true}'`,
    '  exit 0',
    'fi',
  ],
  'command-code': [
    'if [ "$1" = "status" ]; then',
    `  printf '%s\\n' '{"authenticated": true}'`,
    '  exit 0',
    'fi',
  ],
  antigravity: [
    'if [ "$1" = "models" ]; then',
    `  printf '%s\\n' 'gemini-3-pro'`,
    '  exit 0',
    'fi',
  ],
};

function cliShimScript(tool: CliToolId, argvLog: string | undefined): string {
  const version = `${CLI_VERSION_LABELS[tool]}${CLI_TOOL_CATALOG[tool].compatibility.testedVersion}`;
  return [
    '#!/bin/sh',
    ...(argvLog === undefined ? [] : [`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`]),
    // `agy` has no version flag: `agy --help` exiting 0 is its whole version probe.
    `if [ "$1" = "--version" ] || [ "$1" = "--help" ]; then`,
    `  printf '%s\\n' '${version}'`,
    '  exit 0',
    'fi',
    ...(CLI_AUTH_STATUS_RESPONSES[tool] ?? []),
    'exit 1',
    '',
  ].join('\n');
}

/**
 * Isolates PATH, HOME-family state roots, and credential env so detection can
 * only see the installed shims and the seeded session files — never this
 * machine's real logins, keychain, or auth files.
 */
async function withAdmittedCliHost(
  input: Readonly<{
    shims: readonly CliToolId[];
    sessionState: readonly string[];
    argvLogTool?: CliToolId | undefined;
    run: (host: Readonly<{ argvLog: string }>) => Promise<void>;
  }>,
): Promise<void> {
  const shimDir = createTempDir('admitted-cli-shims');
  const stateHome = createTempDir('admitted-cli-home');
  const argvLog = join(shimDir, 'argv.log');
  const saved = HOST_DETECTION_ENV.map((name) => [name, process.env[name]] as const);
  try {
    for (const tool of input.shims) {
      const shim = join(shimDir, CLI_TOOL_CATALOG[tool].command);
      writeFileSync(shim, cliShimScript(tool, input.argvLogTool === tool ? argvLog : undefined));
      chmodSync(shim, 0o755);
    }
    for (const relativePath of input.sessionState) {
      mkdirSync(join(stateHome, dirname(relativePath)), { recursive: true });
      writeFileSync(join(stateHome, relativePath), '{"session":"stub"}\n', 'utf8');
    }
    for (const name of HOST_DETECTION_ENV) delete process.env[name];
    process.env.PATH = shimDir;
    process.env.HOME = stateHome;
    await input.run({ argvLog });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    cleanupTempDir(shimDir);
    cleanupTempDir(stateHome);
  }
}

function shellRolesConfig() {
  return makeConfig({
    planner: { kind: 'shell', command: 'printf planner' },
    implementer: { kind: 'shell', command: 'printf implementer', model: 'shell-model' },
  });
}

// Copilot is unlisted: detection probes it only for a config that names it.
function copilotFallbackConfig() {
  return makeConfig({
    planner: { kind: 'shell', command: 'printf planner' },
    implementer: {
      kind: 'shell',
      command: 'printf implementer',
      model: 'shell-model',
      fallback: { tool: 'copilot' },
    },
  });
}

describe('all-admitted-tools auth channels', () => {
  it.runIf(process.platform !== 'win32')(
    'probes every admitted CLI on its default channel when no CLI runner is active',
    async () => {
      await withAdmittedCliHost({
        shims: [...CLI_TOOL_IDS],
        sessionState: SEEDED_SESSION_STATE_PATHS,
        run: async () => {
          const result = await createProductionDetectionDeps({
            config: copilotFallbackConfig(),
            projectDir: '/projects/all-admitted-tools',
          }).detectAll({ signal: new AbortController().signal });

          expect(Object.fromEntries(result.cliTools.map(({ tool, auth }) => [tool, auth]))).toEqual(
            {
              'claude-code': 'authenticated',
              codex: 'authenticated',
              opencode: 'authenticated',
              // Copilot's macOS token is a keychain item and Copilot has no status
              // command, so there the seeded config file proves nothing.
              copilot: process.platform === 'darwin' ? 'unknown' : 'authenticated',
              'kilo-code': 'authenticated',
              cursor: 'authenticated',
              'command-code': 'authenticated',
              // Antigravity's session is a macOS keychain item, so there `agy models`
              // runs under the host account and its exit decides. Other platforms
              // are denied by the channel policy, so authentication stays unknown.
              antigravity: process.platform === 'darwin' ? 'authenticated' : 'unknown',
            },
          );
          const copilot = result.cliTools.find((detection) => detection.tool === 'copilot');
          expect(copilot?.diagnostic).toMatchObject(
            process.platform === 'darwin'
              ? { state: 'unverified' }
              : { state: 'ready', remediation: null },
          );
        },
      });
    },
    30_000,
  );

  it.runIf(process.platform !== 'win32')(
    'reports absent bridged session state as unauthenticated and unresolvable tools as unavailable',
    async () => {
      // Copilot bridges its files on Linux; on macOS its token is a keychain item.
      const hostPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      onTestFinished(() => {
        Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
      });
      await withAdmittedCliHost({
        shims: ['copilot'],
        sessionState: [],
        run: async () => {
          const result = await createProductionDetectionDeps({
            config: copilotFallbackConfig(),
            projectDir: '/projects/absent-session-state',
          }).detectAll({ signal: new AbortController().signal });

          const byTool = new Map(result.cliTools.map((detection) => [detection.tool, detection]));
          expect(byTool.get('copilot')).toMatchObject({
            auth: 'unauthenticated',
            diagnostic: { state: 'unauthenticated' },
          });
          for (const tool of LISTED_CLI_TOOL_IDS) {
            expect(byTool.get(tool)).toMatchObject({
              auth: 'not-checked',
              diagnostic: { state: 'unavailable' },
            });
          }
        },
      });
    },
    30_000,
  );

  it.runIf(process.platform !== 'win32')(
    'gives no Copilot row for a config that does not name Copilot',
    async () => {
      await withAdmittedCliHost({
        shims: ['copilot'],
        sessionState: [],
        run: async () => {
          const result = await createProductionDetectionDeps({
            config: shellRolesConfig(),
            projectDir: '/projects/unlisted-copilot',
          }).detectAll({ signal: new AbortController().signal });

          expect(result.cliTools.map((detection) => detection.tool)).toEqual([
            ...LISTED_CLI_TOOL_IDS,
          ]);
        },
      });
    },
    30_000,
  );

  it('keeps the detection context keys of a config whose seats run CLI tools', () => {
    const hostPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
    });
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex' },
      implementer: { kind: 'cli', tool: 'claude-code' },
      reviewer: { kind: 'cli', tool: 'opencode' },
    });

    const { sourceContexts } = createProductionDetectionDeps({
      config,
      projectDir: '/projects/context-key-pin',
    });

    const seats =
      'cli%3Acodex%3Acli%3Aclaude-code%3Acli%3Aopencode|no-executable-fingerprint|no-executable-version|session%3Asession%3Aprovider-dependent|none%3Anone%3Anone|runner-evidence-v2%7Cplanner%7Cplanner%7Ccli%7Ccodex%7Cunselected%7Csession%7Cnone%7Cnone%7Ccredential-absent%7Ccredential-domain%7Cabsent%7Cconfig-d4471361cc9f6473%3Arunner-evidence-v2%7Cimplementer%7Cimplementer%7Ccli%7Cclaude-code%7Cunselected%7Csession%7Cnone%7Cnone%7Ccredential-absent%7Ccredential-domain%7Cabsent%7Cconfig-d4471361cc9f6473%3Arunner-evidence-v2%7Cplanner%7Creviewer%7Ccli%7Copencode%7Cunselected%7Cprovider-dependent%7Cnone%7Cnone%7Ccredential-absent%7Ccredential-domain%7Cabsent%7Cconfig-d4471361cc9f6473|project-f1ec92c43bc305c0%3Aconfig-d4471361cc9f6473%3Aconfig-d4471361cc9f6473%3Aconfig-d4471361cc9f6473';
    expect(sourceContexts).toEqual({
      readiness: `detection-context-v1|linux|readiness%3Aall-tools%3A${seats}`,
      modelsDev: `detection-context-v1|linux|modelsDev%3A${seats}`,
      cliModels: `detection-context-v1|linux|cliModels%3Aper-tool%3A${seats}`,
      configuredProviders: [],
    });
  });

  it('keeps the detection context keys of a config whose seats run shell commands', () => {
    const hostPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
    });

    const { sourceContexts } = createProductionDetectionDeps({
      config: shellRolesConfig(),
      projectDir: '/projects/context-key-pin',
    });

    const seats =
      'shell%3Ashell%3Ashell%3Ashell%3Ashell%3Ashell|no-executable-fingerprint|no-executable-version|none%3Anone%3Anone|none%3Anone%3Anone|runner-evidence-v2%7Cplanner%7Cplanner%7Cshell%7Cshell%7Cunselected%7Cnot-selected%7Cnone%7Cnone%7Ccredential-absent%7Ccredential-domain%7Cabsent%7Cconfig-5c56cad80fbe9343%3Arunner-evidence-v2%7Cimplementer%7Cimplementer%7Cshell%7Cshell%7Cshell-model%7Cnot-selected%7Cnone%7Cnone%7Ccredential-absent%7Ccredential-domain%7Cabsent%7Cconfig-5c56cad80fbe9343%3Arunner-evidence-v2%7Cplanner%7Creviewer%7Cshell%7Cshell%7Cunselected%7Cnot-selected%7Cnone%7Cnone%7Ccredential-absent%7Ccredential-domain%7Cabsent%7Cconfig-5c56cad80fbe9343|project-f1ec92c43bc305c0%3Aconfig-5c56cad80fbe9343%3Aconfig-5c56cad80fbe9343%3Aconfig-5c56cad80fbe9343';
    expect(sourceContexts).toEqual({
      readiness: `detection-context-v1|linux|readiness%3Aall-tools%3A${seats}`,
      modelsDev: `detection-context-v1|linux|modelsDev%3A${seats}`,
      cliModels: `detection-context-v1|linux|cliModels%3Aper-tool%3A${seats}`,
      configuredProviders: [],
    });
  });
});

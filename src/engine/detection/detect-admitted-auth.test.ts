import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeProbeDeadlines } from '#testing/helpers/fake-timers.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { CLI_TOOL_CATALOG, LISTED_CLI_TOOL_IDS } from '../../core/runners/cli-tool/catalog.js';
import { error } from '../../utils/error.js';
import { resolveCliExecutable } from '../runners/cli-executable/resolve.js';
import { detectAvailableCliTools } from './detect.js';

const HOST_STATE_ENV = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

freezeProbeDeadlines();

describe('all-admitted-tools auth detection', () => {
  it('keeps an unresolvable tool unavailable without any auth probe', async () => {
    const results = await detectAvailableCliTools({
      resolveExecutable: async () => {
        throw error('cli-executable-unavailable', 'not installed');
      },
      now: () => 11,
    });

    expect(
      results.map((result) => ({
        tool: result.tool,
        state: result.diagnostic.state,
        auth: result.auth,
      })),
    ).toEqual(
      LISTED_CLI_TOOL_IDS.map((tool) => ({ tool, state: 'unavailable', auth: 'not-checked' })),
    );
  });

  it.runIf(process.platform !== 'win32')(
    'surfaces per-provider oracle facts for kilo-code from bridged data-dir state',
    async () => {
      const shimDir = createTempDir('detect-kilo-shim');
      const stateHome = createTempDir('detect-kilo-home');
      const saved = HOST_STATE_ENV.map((name) => [name, process.env[name]] as const);
      try {
        const listing =
          '┌  Credentials \u001b[90m~/.local/share/kilo/auth.json\n│\n●  GitHub Copilot \u001b[90moauth\n│\n└  1 credentials\n';
        const shim = join(shimDir, 'kilo');
        await writeFile(
          shim,
          [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then',
            `  printf '%s\\n' '${CLI_TOOL_CATALOG['kilo-code'].compatibility.testedVersion}'`,
            '  exit 0',
            'fi',
            'if [ "$1" = "auth" ] && [ "$2" = "list" ]; then',
            "  cat <<'SPLITBRIEF_ORACLE'",
            listing.trimEnd(),
            'SPLITBRIEF_ORACLE',
            '  exit 0',
            'fi',
            'exit 1',
            '',
          ].join('\n'),
        );
        await chmod(shim, 0o755);
        const executable = await resolveCliExecutable({
          command: shim,
          projectDir: '/neutral/project',
        });
        await mkdir(join(stateHome, '.local', 'share', 'kilo'), { recursive: true });
        await writeFile(
          join(stateHome, '.local', 'share', 'kilo', 'auth.json'),
          '{"github-copilot":{"type":"oauth"}}',
        );
        for (const name of HOST_STATE_ENV) delete process.env[name];
        process.env.HOME = stateHome;

        const [result] = await detectAvailableCliTools({
          tools: ['kilo-code'],
          resolveExecutable: async () => executable,
        });

        expect(result).toMatchObject({
          tool: 'kilo-code',
          auth: 'authenticated',
          diagnostic: { state: 'ready' },
        });
        expect(result?.providerAuth).toEqual({
          kind: 'read',
          facts: [{ provider: 'GitHub Copilot', source: 'oauth' }],
        });
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        cleanupTempDir(shimDir);
        cleanupTempDir(stateHome);
      }
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'reports claude-code session as unauthenticated when the tool itself reports no session',
    async () => {
      const shimDir = createTempDir('detect-claude-session');
      const emptyHome = createTempDir('detect-claude-home');
      const saved = HOST_STATE_ENV.map((name) => [name, process.env[name]] as const);
      try {
        const shim = join(shimDir, 'claude');
        await writeFile(
          shim,
          [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then',
            `  printf '%s\\n' 'claude ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}'`,
            '  exit 0',
            'fi',
            // Byte-for-byte what the real binary prints when it holds no
            // session, whether it looked in a file or in the OS keychain.
            'if [ "$1" = "auth" ]; then',
            '  printf \'%s\\n\' \'{"loggedIn": false, "authMethod": "none"}\'',
            '  exit 1',
            'fi',
            'exit 1',
            '',
          ].join('\n'),
        );
        await chmod(shim, 0o755);
        const executable = await resolveCliExecutable({
          command: shim,
          projectDir: '/neutral/project',
        });
        for (const name of HOST_STATE_ENV) delete process.env[name];
        process.env.HOME = emptyHome;

        const [result] = await detectAvailableCliTools({
          tools: ['claude-code'],
          resolveExecutable: async () => executable,
        });

        expect(result).toMatchObject({
          tool: 'claude-code',
          auth: 'unauthenticated',
          diagnostic: { state: 'unauthenticated' },
        });
        expect(result?.diagnostic.remediation).toContain(
          'Sign in to Claude Code CLI, then ctrl+r.',
        );
        expect(result?.diagnostic.remediation).not.toContain('ANTHROPIC_API_KEY');
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        cleanupTempDir(shimDir);
        cleanupTempDir(emptyHome);
      }
    },
    20_000,
  );
});

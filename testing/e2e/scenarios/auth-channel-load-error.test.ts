import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { configPath } from '../../../src/core/config/load/document.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

/**
 * A project whose PLAN or REVIEW seat is a signed-in fake Claude Code and whose config still
 * names `auth_channel: session` on it. The fake logs every call it gets, so a probe shows up.
 */
function authChannelProject(block: 'planner' | 'reviewer'): {
  target: StopContinueFixture;
  calls: string;
} {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  fixture = target;
  trustHome = createTrustHome('e2e-auth-channel-load-error');
  mkdirSync(join(trustHome.home, '.claude'), { recursive: true });
  writeFileSync(join(trustHome.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
  const calls = join(target.tmpDir, 'claude-calls.log');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  writeFakeNodeCli(
    binDir,
    'claude',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (args[0] === '--version') {
  console.log('claude ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
process.exit(1);`,
  );
  restorePath = activateSafeCliShimPath(binDir);
  const file = configPath(target.projectDir);
  const yaml: Record<string, unknown> = YAML.parse(readFileSync(file, 'utf8'));
  writeFileSync(
    file,
    YAML.stringify({
      ...yaml,
      [block]: { kind: 'cli', tool: 'claude-code', auth_channel: 'session' },
    }),
  );
  return { target, calls };
}

describe('e2e: a config that still names auth_channel on a CLI runner', () => {
  it.each(['planner', 'reviewer'] as const)(
    'stops the start with a load error that names the key in the %s block, before any tool is probed',
    async (block) => {
      const { target, calls } = authChannelProject(block);

      const start = await cli(target, ['start', 'smoke']);

      const output = stripVTControlCharacters(`${start.stdout}${start.stderr}`);
      expect(start.exitCode, output).toBe(1);
      expect(output).toContain(
        `${block}.authChannel: Unknown config key — remove it or use the current spelling from docs/CONFIGURATION.md.`,
      );
      expect(output).not.toContain('Run readiness');
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : null).toBeNull();
    },
  );
});

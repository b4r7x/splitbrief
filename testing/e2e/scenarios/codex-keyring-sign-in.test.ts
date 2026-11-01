import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const KEYRING =
  'OpenAI Codex CLI keeps its sign-in in the system keyring, which a run cannot reach.';
const KEYRING_FIX =
  'Set cli_auth_credentials_store = "file" in config.toml and run codex login again, or use OPENAI_API_KEY';

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
 * A project whose BUILD seat is a fake Codex CLI, in a throwaway home whose Codex config keeps
 * the sign-in in the keyring and holds no auth.json. The fake reports a sign-in, as Codex does
 * on such a host, and writes a marker when a run gives it a task.
 */
function codexKeyringProject(store: 'keyring' | 'auto'): {
  target: StopContinueFixture;
  ran: string;
} {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  fixture = target;
  trustHome = createTrustHome('e2e-codex-keyring-sign-in');
  mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
  writeFileSync(
    join(trustHome.home, '.codex', 'config.toml'),
    `cli_auth_credentials_store = "${store}"\n`,
  );
  vi.stubEnv('CODEX_HOME', undefined);
  vi.stubEnv('OPENAI_API_KEY', undefined);
  const ran = join(target.tmpDir, 'codex-ran');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  writeFakeNodeCli(
    binDir,
    'codex',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (!args.includes('exec')) process.exit(0);
fs.appendFileSync(${JSON.stringify(ran)}, args.join(' ') + '\\n');
process.exit(1);`,
  );
  restorePath = activateSafeCliShimPath(binDir);
  writeConfig(target.projectDir, {
    ...loadConfig(target.projectDir).config,
    implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
  });
  return { target, ran };
}

describe('e2e: a Codex seat on a host that keeps the sign-in in the keyring', () => {
  it.each(['keyring', 'auto'] as const)(
    'names the keyring and its fix in doctor and blocks the start before Codex runs (%s store)',
    async (store) => {
      const { target, ran } = codexKeyringProject(store);

      const doctor = await cli(target, ['doctor']);
      const report = stripVTControlCharacters(doctor.stdout);
      expect(report, doctor.stderr).toContain(KEYRING);
      expect(report).toContain(KEYRING_FIX);
      expect(report).not.toContain('REDACTED');

      const start = await cli(target, ['start', 'smoke']);
      expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(1);
      const blocked = stripVTControlCharacters(`${start.stdout}${start.stderr}`);
      expect(blocked).toContain(KEYRING);
      expect(blocked).toContain(KEYRING_FIX);
      expect(blocked).not.toContain('REDACTED');
      expect(existsSync(ran) ? readFileSync(ran, 'utf8') : null).toBeNull();
    },
  );
});

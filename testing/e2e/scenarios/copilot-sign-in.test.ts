import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { prependPath, writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const SIGNED_IN = 'GitHub Copilot CLI is installed, trusted, compatible, and signed in.';
const SIGN_IN_UNKNOWN = 'GitHub Copilot CLI sign-in status is unknown.';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let home: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  home?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  home = undefined;
});

/**
 * A project whose BUILD seat is a fake Copilot that records the token it was given, in a
 * throwaway home that holds no Copilot sign-in unless a test writes one.
 */
function copilotProject(): { target: StopContinueFixture; seen: string; hostHome: string } {
  const target = createStopContinueFixture(undefined, { isolation: 'none' });
  fixture = target;
  const trustHome = createTrustHome('e2e-copilot-sign-in-home');
  home = trustHome;
  vi.stubEnv('XDG_CONFIG_HOME', join(trustHome.home, 'xdg'));
  vi.stubEnv('COPILOT_HOME', undefined);
  vi.stubEnv('GH_TOKEN', undefined);
  vi.stubEnv('GITHUB_TOKEN', undefined);
  const seen = join(target.tmpDir, 'copilot-seen.json');
  const bin = join(target.tmpDir, 'bin');
  mkdirSync(bin);
  writeFakeNodeCli(
    bin,
    'copilot',
    `
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('copilot ${CLI_TOOL_CATALOG.copilot.compatibility.testedVersion}');
  process.exit(0);
}
if (!process.argv.includes('--output-format')) process.exit(0);
readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ token: process.env.COPILOT_GITHUB_TOKEN ?? null }));
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'assistant.message', data: { text: 'Implemented the greeting.' } }));
`,
  );
  restorePath = prependPath(bin);
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'copilot', contextLength: 200_000 },
  });
  return { target, seen, hostHome: trustHome.home };
}

function builtCli(
  target: StopContinueFixture,
  args: readonly string[],
): ReturnType<typeof spawnCli> {
  return spawnCli({
    args: ['dist/cli.js', ...args, '--project', target.projectDir],
    stateHome: target.stateHome,
    timeoutMs: 60_000,
  });
}

describe('e2e: GitHub Copilot CLI sign-in', { timeout: 120_000 }, () => {
  it('reads COPILOT_GITHUB_TOKEN as the sign-in and hands it to Copilot', async () => {
    const { target, seen } = copilotProject();
    vi.stubEnv('COPILOT_GITHUB_TOKEN', 'github_pat_e2e_copilot_fixture');

    const doctor = await builtCli(target, ['doctor']);
    expect(stripVTControlCharacters(doctor.stdout), doctor.stderr).toContain(SIGNED_IN);

    const start = await builtCli(target, ['start', 'smoke', '--plain', '--allow-repo-runners']);
    expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual({
      token: 'github_pat_e2e_copilot_fixture',
    });
  });

  // On macOS Copilot keeps its token in the login keychain, and `config.json` only lists
  // the signed-in users, so the file alone is no sign-in.
  it.runIf(process.platform === 'darwin')(
    'does not read a macOS Copilot config file as a sign-in',
    async () => {
      const { target, seen, hostHome } = copilotProject();
      vi.stubEnv('COPILOT_GITHUB_TOKEN', undefined);
      mkdirSync(join(hostHome, '.copilot'));
      writeFileSync(
        join(hostHome, '.copilot', 'config.json'),
        '{"loggedInUsers":[{"host":"https://github.com","login":"fixture"}]}\n',
      );

      const doctor = await builtCli(target, ['doctor']);
      const out = stripVTControlCharacters(doctor.stdout);
      expect(out, doctor.stderr).toContain(SIGN_IN_UNKNOWN);
      expect(out).not.toContain(SIGNED_IN);

      const start = await builtCli(target, ['start', 'smoke', '--plain', '--allow-repo-runners']);
      expect(start.exitCode).toBe(1);
      expect(`${start.stdout}${start.stderr}`).toContain(SIGN_IN_UNKNOWN);
      expect(() => readFileSync(seen, 'utf8')).toThrow();
    },
  );
});

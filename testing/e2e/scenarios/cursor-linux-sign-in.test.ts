import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
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

const SIGNED_IN = 'Cursor Agent CLI is installed, trusted, compatible, and signed in.';
const NOT_SIGNED_IN = 'Cursor Agent CLI is not signed in.';

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

interface Seen {
  xdg: string;
  isLink: boolean;
  target: string;
}

/**
 * A project whose BUILD seat is a fake Cursor Agent CLI, in a throwaway home that holds no
 * Cursor sign-in unless a test writes one. The fake answers `status` from the sign-in file
 * it can see, and on a run records that file, then rotates it the way Cursor does.
 */
function cursorProject(xdgConfigHome: 'default' | 'set'): {
  target: StopContinueFixture;
  seen: string;
  hostHome: string;
} {
  const target = createStopContinueFixture(undefined, { isolation: 'none' });
  fixture = target;
  const trustHome = createTrustHome('e2e-cursor-linux-sign-in-home');
  home = trustHome;
  vi.stubEnv('XDG_CONFIG_HOME', xdgConfigHome === 'set' ? join(trustHome.home, 'xdg') : undefined);
  vi.stubEnv('CURSOR_API_KEY', undefined);
  const seen = join(target.tmpDir, 'cursor-seen.json');
  const bin = join(target.tmpDir, 'bin');
  mkdirSync(bin);
  writeFakeNodeCli(
    bin,
    'cursor-agent',
    `
const { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const auth = join(xdg, 'cursor', 'auth.json');
if (process.argv.includes('--version')) {
  console.log(${JSON.stringify(CLI_TOOL_CATALOG.cursor.compatibility.testedVersion)});
  process.exit(0);
}
if (process.argv[2] === 'status') {
  console.log(existsSync(auth) ? 'Logged in as fixture@example.com' : 'Not logged in');
  process.exit(0);
}
if (!process.argv.includes('--print')) process.exit(0);
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ xdg, isLink: lstatSync(auth).isSymbolicLink(), target: realpathSync(auth) }));
writeFileSync(auth, '{"accessToken":"rotated-e2e"}');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Implemented the greeting.' }] }, session_id: 's' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
`,
  );
  restorePath = prependPath(bin);
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'cursor', contextLength: 200_000 },
  });
  return { target, seen, hostHome: trustHome.home };
}

function seedFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
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

function authLinksUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
    (entry) => entry.endsWith('auth.json') && lstatSync(join(dir, entry)).isSymbolicLink(),
  );
}

// On macOS Cursor keeps its sign-in in the login keychain and the run gets the real HOME;
// the file sign-in and its link exist only on Linux and Windows.
describe.runIf(process.platform === 'linux')(
  'e2e: Cursor Agent CLI sign-in on Linux',
  { timeout: 120_000 },
  () => {
    it('reads ~/.config/cursor/auth.json as the sign-in and keeps a token Cursor rotates', async () => {
      const { target, seen, hostHome } = cursorProject('default');
      const hostAuth = seedFile(
        join(hostHome, '.config', 'cursor', 'auth.json'),
        '{"accessToken":"host-e2e"}',
      );

      const doctor = await builtCli(target, ['doctor']);
      expect(stripVTControlCharacters(doctor.stdout), doctor.stderr).toContain(SIGNED_IN);

      const start = await builtCli(target, ['start', 'smoke', '--plain', '--allow-repo-runners']);
      expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(0);
      const sandbox = join(target.projectDir, SPLITBRIEF_DIR, 'sandbox');
      const record = JSON.parse(readFileSync(seen, 'utf8')) as Seen;
      expect(record.isLink).toBe(true);
      expect(record.target).toBe(realpathSync(hostAuth));
      expect(realpathSync(record.xdg).startsWith(realpathSync(sandbox))).toBe(true);
      expect(readFileSync(hostAuth, 'utf8')).toContain('rotated-e2e');
      expect(authLinksUnder(sandbox)).toEqual([]);
    });

    it('reads $XDG_CONFIG_HOME/cursor/auth.json as the sign-in', async () => {
      const { target, hostHome } = cursorProject('set');
      seedFile(join(hostHome, 'xdg', 'cursor', 'auth.json'), '{"accessToken":"host-e2e"}');

      const doctor = await builtCli(target, ['doctor']);
      expect(stripVTControlCharacters(doctor.stdout), doctor.stderr).toContain(SIGNED_IN);
    });

    it('does not read the Cursor UI state file as a sign-in', async () => {
      const { target, seen, hostHome } = cursorProject('default');
      seedFile(join(hostHome, '.cursor', 'agent-cli-state.json'), '{"version":1}');

      const doctor = await builtCli(target, ['doctor']);
      const out = stripVTControlCharacters(doctor.stdout);
      expect(out, doctor.stderr).toContain(NOT_SIGNED_IN);
      expect(out).not.toContain(SIGNED_IN);

      const start = await builtCli(target, ['start', 'smoke', '--plain', '--allow-repo-runners']);
      expect(start.exitCode).toBe(1);
      expect(`${start.stdout}${start.stderr}`).toContain(NOT_SIGNED_IN);
      expect(existsSync(seen)).toBe(false);
    });
  },
);

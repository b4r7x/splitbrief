import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import '#testing/helpers/cli/ink-mocks.js';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDefaultConfig } from '../../../src/core/config/load/io.js';
import { defaultCliAuthChannel } from '../../../src/core/runners/cli-tool-catalog.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';

// Runner availability is a live network claim, and the default config points the
// implementer at a local Ollama. The shared no-claim mock keeps the verdict off
// whatever daemon this machine happens to be running.
vi.mock('../../../src/engine/runners/probe-availability.js', () => ({
  probeRunnerAvailability: async (
    ...args: Parameters<
      typeof import('../../../src/engine/runners/probe-availability.js').probeRunnerAvailability
    >
  ) => (await import('#testing/helpers/start-command.js')).probeRunnerAvailabilityMock(...args),
}));

let tmp: string;
let shimDir: string;
let restoreCompatibleCliShim: (() => void) | undefined;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-start-happy');
  shimDir = createTempDir('cli-start-happy-shim');
  createTestGitRepo(tmp);
  process.stdin.isTTY = true;
  const splitbriefDir = join(tmp, SPLITBRIEF_DIR);
  mkdirSync(splitbriefDir, { recursive: true });
  writeFileSync(
    join(splitbriefDir, CONFIG_FILE),
    YAML.stringify(toYaml(createDefaultConfig())),
    'utf-8',
  );
  // The shim must satisfy the channel the product's own default config names,
  // which is not `session` on a platform whose credential store the sandbox
  // cannot read.
  restoreCompatibleCliShim = activateCompatibleCliShim(
    installCompatibleCliShim({
      directory: shimDir,
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    }),
    'test-only-start-happy-path-key',
  );
});

afterEach(() => {
  restoreCompatibleCliShim?.();
  restoreCompatibleCliShim = undefined;
  cleanupTempDir(shimDir);
  cleanupTempDir(tmp);
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('CLI integration: start happy path', { timeout: 90_000 }, () => {
  it('creates a session directory and active marker when starting a new workflow', async () => {
    const { exitCode, stderr, stdout } = await runCommand([
      'start',
      '--project',
      tmp,
      'add endpoint',
    ]);

    expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
    const sessionsRoot = join(tmp, SPLITBRIEF_DIR, 'sessions');
    const ids = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
    expect(ids).toHaveLength(1);
    const [sessionId] = ids;
    if (!sessionId) throw new Error('session id missing');
    expect(sessionId).toMatch(/add-endpoint/);
    expect(readActive(tmp)).toBe(sessionId);
  }, 90_000);
});

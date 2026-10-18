import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { buildActivityBatchViewModel } from '../../../src/features/workflow/conversation-rows/activity-batch-model.js';
import { prependPath, writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

it('shows both file reads when a CLI tool supplies no upstream tool-use ids', async () => {
  const target = createStopContinueFixture(undefined, { isolation: 'none' });
  // Copilot has no auth status command: on Linux readiness takes its config file as the sign-in
  // fact, and on macOS the sign-in is unknown, which `--allow-unverified-auth` admits. The CLI
  // reads from a throwaway home, never from the host's own Copilot session.
  const home = useTrustHome('tool-activity-home');
  vi.stubEnv('XDG_CONFIG_HOME', join(home.home, 'xdg'));
  mkdirSync(join(home.home, '.copilot'));
  writeFileSync(join(home.home, '.copilot', 'config.json'), '{"fixture":true}\n');
  const shims = join(target.tmpDir, 'bin');
  mkdirSync(shims);
  writeFakeNodeCli(
    shims,
    'copilot',
    `
const { mkdirSync, writeFileSync } = require('node:fs');
if (process.argv.includes('--version')) { console.log('copilot 1.0.77'); process.exit(0); }
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
for (const file of [${JSON.stringify(GREET_FILE)}, ${JSON.stringify(MARKER_FILE)}]) {
  console.log(JSON.stringify({ type: 'tool.use', data: { name: 'Read', input: { file_path: file } } }));
}
console.log(JSON.stringify({ type: 'assistant.message', data: { text: 'Implemented the greeting.' } }));
`,
  );
  const restorePath = prependPath(shims);
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'copilot', contextLength: 200_000 },
  });
  try {
    const run = await cli(target, ['start', 'smoke', '--allow-unverified-auth']);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    const reads = events
      .filter((event) => event.type === 'runner_call_activity')
      .filter((event) => event.role === 'implementer' && event.kind === 'read');
    const model = buildActivityBatchViewModel({ batchKey: 'reads', events: reads, expanded: true });
    expect(model.headerCount).toBe(2);
    expect(model.visibleItems.map((item) => item.value)).toEqual([GREET_FILE, MARKER_FILE]);
  } finally {
    restorePath();
    vi.unstubAllEnvs();
    home.restore();
    cleanupTempDir(target.tmpDir);
  }
});

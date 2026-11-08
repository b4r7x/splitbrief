import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { buildActivityBatchViewModel } from '../../../src/features/workflow/conversation-rows/activity-batch-model.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { prependPath, writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { flushEffects } from '#testing/helpers/ink.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/**
 * The planner answers the plan and every later prompt, and exits 1 on the final review, so the
 * run halts after the build with its activity block saved.
 */
const CRASHING_REVIEW_CONSULT = `(prompt) => {
  if (prompt.includes('Final Implementation Review')) {
    process.stderr.write('The planner process crashed.\\n');
    process.exit(1);
  }
  return undefined;
}`;

/** Opens the halted run, scrolls up until the frame shows `row`, and returns that frame. */
async function haltedRunFrame(target: StopContinueFixture, row: string): Promise<string> {
  const opened = await openHaltedRun(target, { heading: 'Final review reached no verdict' });
  try {
    for (let press = 0; press < 80; press += 1) {
      if (stripAnsiStyles(opened.screen.lastFrame()).includes(row)) break;
      opened.screen.stdin.write('\x1b[1;2A');
      await flushEffects();
    }
    return stripAnsiStyles(opened.screen.lastFrame());
  } finally {
    opened.screen.unmount();
    await settleOpenedRuns();
  }
}

/**
 * A run whose BUILD seat is a fake Copilot: it writes the greeting, then prints `toolLines`.
 * Returns the fixture and the clean-up.
 */
function fakeCopilotRun(
  options: Parameters<typeof createStopContinueFixture>[1],
  toolLines: string,
): { target: StopContinueFixture; cleanup: () => void } {
  const target = createStopContinueFixture(undefined, options);
  // Copilot has no auth status command: on Linux readiness takes its config file as the sign-in
  // fact, and on macOS the sign-in is unknown, which `--allow-unverified-auth` admits. The CLI
  // reads from a throwaway home, never from the host's own Copilot session.
  const home = createTrustHome('tool-activity-home');
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
${toolLines}
`,
  );
  const restorePath = prependPath(shims);
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'copilot', contextLength: 200_000 },
  });
  return {
    target,
    cleanup: () => {
      restorePath();
      vi.unstubAllEnvs();
      home.restore();
      cleanupTempDir(target.tmpDir);
    },
  };
}

it('shows both file reads when a CLI tool supplies no upstream tool-use ids', async () => {
  const { target, cleanup } = fakeCopilotRun(
    { isolation: 'none' },
    `for (const file of [${JSON.stringify(GREET_FILE)}, ${JSON.stringify(MARKER_FILE)}]) {
  console.log(JSON.stringify({ type: 'tool.use', data: { name: 'Read', input: { file_path: file } } }));
}
console.log(JSON.stringify({ type: 'assistant.message', data: { text: 'Implemented the greeting.' } }));`,
  );
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
    cleanup();
  }
});

it('names the folder and the glob of each search in the BUILD activity block', async () => {
  const { target, cleanup } = fakeCopilotRun(
    { isolation: 'none', consult: () => CRASHING_REVIEW_CONSULT },
    `const { join } = require('node:path');
const cwd = process.cwd();
for (const input of [
  { pattern: 'renewalWindow', path: join(cwd, 'src', 'loans'), glob: '*.ts' },
  { pattern: 'renewalWindow', path: join(cwd, 'src', 'loans', 'rules') },
  { pattern: 'renewalWindow', path: cwd },
]) {
  console.log(JSON.stringify({ type: 'tool.use', data: { name: 'grep', input } }));
}
console.log(JSON.stringify({ type: 'assistant.message', data: { text: 'Searched the renewals.' } }));`,
  );
  try {
    const run = await cli(target, ['start', 'smoke', '--allow-unverified-auth']);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    const frame = await haltedRunFrame(target, 'Search  renewalWindow · src/loans · *.ts');
    expect(frame).toContain('Search  renewalWindow · src/loans · *.ts');
    expect(frame).toContain('Search  renewalWindow · src/loans/rules');
    expect(frame.match(/Search {2}renewalWindow *$/gm)).toHaveLength(1);
  } finally {
    cleanup();
  }
});

it('names the glob of each OpenCode search in the BUILD activity block', async () => {
  const target = createStopContinueFixture(undefined, {
    isolation: 'none',
    consult: () => CRASHING_REVIEW_CONSULT,
  });
  const home = createTrustHome('tool-activity-opencode-home');
  // OpenCode reads its config and its sign-in under this home, never under the tester's.
  vi.stubEnv('XDG_CONFIG_HOME', join(home.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', join(home.home, '.local', 'share'));
  const opencodeData = join(home.home, '.local', 'share', 'opencode');
  mkdirSync(opencodeData, { recursive: true });
  writeFileSync(join(opencodeData, 'auth.json'), '{"anthropic":{"type":"api"}}');
  const shims = join(target.tmpDir, 'bin');
  mkdirSync(shims);
  // OpenCode 2 starts a steering server beside each call; the fake's server answers nothing.
  writeFakeNodeCli(
    shims,
    'opencode',
    `const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  console.log(${JSON.stringify(JSON.stringify([{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'credential' }] }]))});
  process.exit(0);
}
if (args[0] === 'serve') {
  const server = require('node:http').createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1', () => {
    console.log('server listening on http://127.0.0.1:' + server.address().port);
    console.log('server password tool-activity-sidecar-password');
  });
  return;
}
if (args[0] !== 'run') process.exit(1);
readFileSync(0, 'utf8');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
const loans = join(process.cwd(), 'src', 'loans');
for (const [callID, include] of [['grep-ts', '*.ts'], ['grep-md', '*.md']]) {
  const input = { pattern: 'renewalWindow', path: loans, include };
  console.log(JSON.stringify({ type: 'tool_use', part: { type: 'tool', callID, tool: 'grep', state: { status: 'completed', input } } }));
}
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: 'Searched the renewals.' } }));
console.log(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 10, output: 5 } } }));`,
  );
  const restorePath = prependPath(shims);
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: {
      kind: 'cli',
      tool: 'opencode',
      model: 'anthropic/claude-sonnet-5',
      contextLength: 200_000,
    },
  });
  try {
    const run = await cli(target, ['start', 'smoke', '--allow-unverified-auth']);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    const frame = await haltedRunFrame(target, 'Search  renewalWindow · src/loans · *.ts');
    expect(frame).toContain('Search  renewalWindow · src/loans · *.ts');
    expect(frame).toContain('Search  renewalWindow · src/loans · *.md');
  } finally {
    restorePath();
    vi.unstubAllEnvs();
    home.restore();
    cleanupTempDir(target.tmpDir);
  }
});

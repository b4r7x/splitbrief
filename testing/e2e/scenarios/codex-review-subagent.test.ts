import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEventOf } from '../../../src/engine/events/types.js';
import { buildActivityBatchViewModel } from '../../../src/features/workflow/conversation-rows/activity-batch-model.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

it('lets a Codex REVIEW seat start a sub-agent and names the spawn row', async () => {
  fixture = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`,
    { isolation: 'none' },
  );
  const target = fixture;
  trustHome = useTrustHome('e2e-codex-review-subagent');
  const hostCodex = join(trustHome.home, '.codex');
  mkdirSync(join(hostCodex, 'sessions'), { recursive: true });
  writeFileSync(
    join(hostCodex, 'auth.json'),
    '{"auth_mode":"chatgpt","tokens":{"refresh_token":"fixture"}}\n',
  );
  writeFileSync(join(hostCodex, 'config.toml'), 'model = "gpt-5"\n');

  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  const verdict = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
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
if (!args.includes('exec')) throw new Error('Unexpected invocation: ' + args.join(' '));
fs.readFileSync(0, 'utf8');

if (args.includes('--ephemeral')) {
  process.stderr.write('2026-10-24T11:05:33.637483Z ERROR codex_core::tools::router: error=collab spawn failed: Fatal error: failed to load model context for thread 01a16d96-01dd-7df1-b4d6-51ffa50e10a5: invalid thread-store request: no rollout found for thread id 01a16d96-01dd-7df1-b4d6-51ffa50e10a5\\n');
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'collab_spawn', type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'check finding F1', status: 'failed' } }));
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'collab spawn failed' } }));
  process.exit(1);
}

const verdict = ${JSON.stringify(verdict)};
console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a16d96-01dd-7df1-b4d6-51ffa50e10a5' }));
console.log(JSON.stringify({ type: 'item.started', item: { id: 'collab_spawn', type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'check finding F1', input: { prompt: 'check finding F1' } } }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'collab_spawn', type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'check finding F1', input: { prompt: 'check finding F1' }, status: 'completed' } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(verdict) } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } }));
process.exit(0);`,
  );
  restorePath = activateSafeCliShimPath(binDir);

  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
  });

  const tools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['codex'],
    authChannels: { codex: 'session' },
    role: 'planner',
  });
  expect(tools[0]?.diagnostic.state).toBe('ready');
  await rememberDetectedTools(target.projectDir, tools);

  const preload = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    preload,
    "globalThis.fetch = async () => { throw new Error('Network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${preload}`);

  const run = await cli(target, ['start', 'smoke'], { timeoutMs: 90_000 });
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

  const sessionIds = readdirSync(sessionsRoot(target.projectDir));
  expect(sessionIds).toHaveLength(1);
  const sessionId = sessionIds[0];
  if (sessionId === undefined) throw new Error('Expected one session directory');

  const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
  const reviewActivities = events.filter(
    (event): event is EngineEventOf<'runner_call_activity'> =>
      event.type === 'runner_call_activity' && event.role === 'review',
  );

  const model = buildActivityBatchViewModel({
    batchKey: 'review-activity',
    events: reviewActivities,
    expanded: true,
  });

  const visibleSummary = model.visibleItems.map((item) => `${item.label} ${item.value}`).join('\n');
  const headerText = model.headerSegments.map((segment) => segment.text).join(' ');
  const combinedReviewView = `${headerText}\n${visibleSummary}`;

  expect(visibleSummary).toContain('AGENT spawn_agent');
  expect(combinedReviewView).not.toContain('collab_tool_call');
  expect(combinedReviewView).not.toContain('collab spawn failed');
  expect(combinedReviewView).not.toContain('1 warn');
  expect(combinedReviewView).not.toContain('check finding F1');

  expect(run.stderr).not.toContain('collab spawn failed');
  expect(run.stdout).not.toContain('collab_tool_call');
  expect(run.stdout).not.toContain('check finding F1');
});

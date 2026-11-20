import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { createEvidenceLedger } from '../../../src/core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { sessionDir } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review/packet.js';
import type { TaskTokenUsage } from '../../../src/core/schemas/tokens.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  continueRun,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** How long the first codex call holds if no stop ends it; a backstop, not a pace. */
const HOLD_MS = 120_000;

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  if (fixture !== undefined) writeFileSync(fixture.releaseHoldPath, '');
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
  resetAllStores();
});

/** A codex that holds on its first BUILD call, so the run stops inside it, and finishes later. */
function installCodex(binDir: string, target: StopContinueFixture): void {
  const calls = join(target.tmpDir, 'codex-calls');
  writeFakeNodeCli(
    binDir,
    'codex',
    `const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (!args.includes('exec')) throw new Error('Unexpected codex invocation: ' + args.join(' '));
readFileSync(0, 'utf8');
const countPath = ${JSON.stringify(calls)};
const call = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
writeFileSync(countPath, String(call));
const emit = (entry) => console.log(JSON.stringify(entry));
emit({ type: 'thread.started', thread_id: 'crew-change-' + call });
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
if (call === 1) {
  const release = ${JSON.stringify(target.releaseHoldPath)};
  const deadline = Date.now() + ${HOLD_MS};
  const hold = setInterval(() => {
    if (existsSync(release) || Date.now() > deadline) { clearInterval(hold); process.exit(1); }
  }, 50);
} else {
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Greeting complete' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
}`,
  );
}

it('lists a BUILD seat changed between stop and continue in the review packet with both identities', {
  timeout: 240_000,
}, async () => {
  fixture = createStopContinueFixture(() => '');
  const target = fixture;
  trustHome = useTrustHome('e2e-crew-change-home');
  mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
  writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  installCodex(binDir, target);
  restorePath = activateSafeCliShimPath(binDir);
  const config = loadConfig(target.projectDir).config;
  const implementer = {
    kind: 'cli',
    tool: 'codex',
    model: 'gpt-5-codex',
    contextLength: 200_000,
  } as const;
  writeConfig(target.projectDir, { ...config, implementer });
  const tools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['codex'],
  });
  expect(tools[0]?.diagnostic.state).toBe('ready');
  await rememberDetectedTools(target.projectDir, tools);
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in crew change E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);

  const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
  expect(parked.exitCode).toBe(130);
  const ref = { projectDir: target.projectDir, sessionId: parked.sessionId };
  const saved = loadState(ref);
  const current = saved?.tasks[0];
  if (saved === null || current === undefined) throw new Error('Missing parked brief');
  const earlierRoute: TaskTokenUsage = {
    taskId: current.id,
    taskTitle: current.title,
    method: 'local',
    retryCount: 0,
    implementerTokens: 7,
    escalationTokens: 0,
    tool: 'codex',
    model: 'gpt-5-codex',
    routingReason: 'The earlier brief fit.',
  };
  saveState(ref, { ...saved, taskBreakdowns: [earlierRoute] });
  const earlier = makeTask({ id: 'T002', title: 'Add farewell', status: 'done' });
  writeEvidenceLedger(
    ref,
    createEvidenceLedger({ ...ref, feature: saved.feature, tasks: [earlier, current] }),
  );

  // What `/crew build` saves: the BUILD block in config.yaml, on another model.
  writeConfig(target.projectDir, {
    ...loadConfig(target.projectDir).config,
    implementer: { ...implementer, model: 'gpt-5.1-codex' },
  });
  const resumed = await continueRun(target);
  expect(resumed.exitCode, resumed.stderr).toBe(0);

  const events = (await readRunEvents(ref)).events;
  expect(events.filter((event) => event.type === 'seat_switched')).toEqual([
    expect.objectContaining({ seat: 'build', cause: 'crew-changed', auto: false }),
  ]);
  expect(
    events.filter((event) => event.type === 'warning' && /seat changed/.test(event.message)),
  ).toEqual([]);
  const artifacts = sessionDir(ref.projectDir, ref.sessionId);
  const packet = readFileSync(join(artifacts, 'review-packet.md'), 'utf8');
  const recovery = packet.slice(
    packet.indexOf('## Recovery Decisions'),
    packet.indexOf('## Routing'),
  );
  expect(recovery).toContain(
    '- BUILD switched manually: OpenAI Codex CLI · GPT-5 Codex → OpenAI Codex CLI · GPT-5.1 Codex; crew changed',
  );
  const recorded = ReviewPacketSchema.parse(
    JSON.parse(readFileSync(join(artifacts, 'review-packet.json'), 'utf8')),
  );
  const routing = packet.split('## Routing\n')[1]?.split('\n## ')[0];
  expect.soft(recorded.routing.taskRouting).toEqual([
    earlierRoute,
    expect.objectContaining({
      taskId: current.id,
      kind: 'cli',
      model: 'gpt-5.1-codex',
      implementerTokens: 15,
    }),
  ]);
  expect.soft(routing).toMatch(/^- T001: codex · GPT-5 Codex · The earlier brief fit\.$/m);
  expect.soft(routing).toMatch(/^- T001: OpenAI Codex CLI · GPT-5\.1 Codex/m);
  expect.soft(packet).toContain('- Tasks: 1 total, 0 escalated, 0 skipped, 0 failed');
  expect.soft(packet).toContain('- Validation: 1 passed, 0 failed, 0 skipped, 0 escalated');
  expect(recorded.validation.tasks.map((task) => [task.taskId, task.status])).toEqual([
    [current.id, 'done'],
  ]);
});

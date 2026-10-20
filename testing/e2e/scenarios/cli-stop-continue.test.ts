import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { WORKSPACE_KEPT_CODE } from '../../../src/core/sessions/workspace-notice.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import {
  continueRun,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** How long the first codex call holds if no stop ends it; a backstop, not a pace. */
const HOLD_MS = 120_000;

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof createTrustHome> | undefined;

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

/**
 * A codex that writes the marker and holds on its first BUILD call, so the run can be stopped
 * inside that call, and finishes the brief on every later call.
 */
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
emit({ type: 'thread.started', thread_id: 'cli-stop-' + call });
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
if (call === 1) {
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Wrote the run marker.' } });
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

async function codexFixture(): Promise<StopContinueFixture> {
  fixture = createStopContinueFixture(() => '');
  const target = fixture;
  trustHome = createTrustHome('e2e-cli-stop-home');
  mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
  writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  installCodex(binDir, target);
  restorePath = activateSafeCliShimPath(binDir);

  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
  });
  const tools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['codex'],
    authChannels: { codex: 'session' },
    role: 'implementer',
  });
  expect(tools[0]?.diagnostic.state).toBe('ready');
  await rememberDetectedTools(target.projectDir, tools);
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in CLI stop E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);
  return target;
}

async function transcriptRows(ref: { projectDir: string; sessionId: string }): Promise<string[]> {
  await hydrateRun(readRunRecord(ref));
  return buildConversationRows({
    sections: groupEventsIntoSections(eventsStore.get().events),
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    cols: 200,
    viewportHeight: 60,
    streaming: { taskId: null, lines: [], active: false },
  }).rows.map(rowText);
}

function indexOfType(events: readonly EngineEvent[], type: EngineEvent['type']): number {
  return events.findIndex((event) => event.type === type);
}

describe('stop a CLI implementer call → continue', { timeout: 240_000 }, () => {
  it('records the stop as an interrupted turn, never an error, and drops the kept notice on continue', async () => {
    const target = await codexFixture();

    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(130);
    expect(readState(target, parked.sessionId).interruptedStep?.cut).toBe('mid-step');
    const ref = { projectDir: target.projectDir, sessionId: parked.sessionId };

    const stopped = (await readRunEvents(ref)).events;
    const cut = stopped.filter((event) => event.type === 'runner_call_error');
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({
      role: 'implementer',
      status: 'aborted',
      error: { code: 'runner_interrupted' },
    });
    expect(
      stopped.some((event) => event.type === 'warning' && event.code === WORKSPACE_KEPT_CODE),
    ).toBe(true);
    const parkedRows = await transcriptRows(ref);
    expect(parkedRows.filter((row) => row.includes('Workspace kept at'))).toHaveLength(1);
    resetAllStores();

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(readState(target, parked.sessionId).tasks[0]?.status).toBe('done');

    const events = (await readRunEvents(ref)).events;
    const keptAt = events.findIndex(
      (event) => event.type === 'warning' && event.code === WORKSPACE_KEPT_CODE,
    );
    expect(keptAt).toBeGreaterThanOrEqual(0);
    expect(keptAt).toBeLessThan(indexOfType(events, 'workflow_resumed'));
    expect(
      events.some(
        (event) => event.type === 'runner_call_error' && event.error.code === 'user-abort',
      ),
    ).toBe(false);

    const rows = await transcriptRows(ref);
    const text = rows.join('\n');
    expect(text).not.toMatch(/\berr\b/i);
    expect(text).not.toContain('user-abort');
    expect(text).not.toContain('runner_interrupted');
    expect(text).not.toContain('Workspace kept at');
    expect(text).not.toContain('CLI invocation');
    expect(rows.filter((row) => row.includes('current turn interrupted'))).toHaveLength(1);
    expect(rows.some((row) => row.includes('current turn interrupted: stopped by you'))).toBe(true);
    expect(rows.some((row) => row.includes('1 update  interrupted'))).toBe(true);
    expect(rows.some((row) => row.includes('Run continued'))).toBe(true);
  });
});

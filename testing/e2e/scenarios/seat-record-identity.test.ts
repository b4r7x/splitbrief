import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { releasePreparedSession } from '../../../src/core/sessions/prepare.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { readSeatIdentities, writeSeatIdentities } from '../../../src/core/state/seats.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { prepareExecution } from '../../../src/engine/runners/prepare-execution/prepare-execution.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const MODEL = 'gpt-6-luna';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  resetAllStores();
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

// Codex's own listing spells the model `GPT-6-Luna`, which every surface shows; the id alone would
// read `GPT-6 Luna`. A run the app drives holds that listing, so its record must say the same.
it('records the BUILD seat in the catalog words every surface shows', async () => {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  trustHome = useTrustHome('e2e-seat-record-identity-home');
  mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
  writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  writeFakeNodeCli(
    binDir,
    'codex',
    `const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
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
readFileSync(0, 'utf8');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Implemented the greeting helper.' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } }));`,
  );
  restorePath = activateSafeCliShimPath(binDir);
  writeConfig(target.projectDir, {
    ...loadConfig(target.projectDir).config,
    implementer: { kind: 'cli', tool: 'codex', model: MODEL, contextLength: 200_000 },
  });
  const tools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['codex'],
    authChannels: { codex: 'session' },
    role: 'implementer',
  });
  expect(tools[0]?.diagnostic.state).toBe('ready');
  await rememberDetectedTools(target.projectDir, tools);

  const preparation = await prepareExecution({
    projectDir: target.projectDir,
    feature: 'smoke',
    effectiveConfig: loadConfig(target.projectDir).config,
    policy: {
      purpose: 'new-workflow',
      interaction: 'headless',
      unverifiedAuth: 'allowed',
      allowRepoRunners: true,
      allowHooks: false,
    },
    signal: new AbortController().signal,
  });
  if (preparation.kind !== 'prepared') throw new Error(`preparation ended '${preparation.kind}'`);
  const ref = preparation.execution.session.ref;
  if (preparation.execution.session.kind === 'new') {
    releasePreparedSession({ ref, ownership: preparation.execution.session.ownership });
  }

  await runWorkflow({
    prepared: preparation.execution,
    headless: true,
    sinks: TEST_WORKFLOW_SINKS,
    modelCache: makeModelCacheAccessor({
      providerModels: {
        codex: [{ id: MODEL, displayName: 'GPT-6-Luna', contextLength: 272_000 }],
      },
    }),
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onPlannerReply: async () => plainUserMessage(''),
      onContinuationNeeded: async () => plainUserMessage(''),
      onComplete: () => undefined,
    },
  });

  expect(loadState(ref)?.phase).toBe('complete');
  expect(readSeatIdentities(ref)).toMatchObject({
    build: 'OpenAI Codex CLI · GPT-6-Luna',
    ids: { build: { tool: 'codex', model: MODEL, axes: [], kind: 'cli' } },
  });
});

// A record from before the axes kept the level an Antigravity id spells holds the effort flag
// alone. Resuming on the same seat must not read that as a move.
it('resumes a session recorded without the level its id spells without a seat notice', async () => {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  restorePath = activateSafeCliShimPath(binDir);
  const seat = { kind: 'cli', tool: 'antigravity', model: 'gemini-3.8-flash-high' } as const;
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, { ...config, planner: seat, implementer: seat, reviewer: seat });
  const ref = { projectDir: target.projectDir, sessionId: '2026-10-13-legacy-seat-record' };
  ensureSessionDir(ref.projectDir, ref.sessionId);
  saveState(ref, {
    ...createInitialState('smoke'),
    phase: 'implementing',
    plannerSessionId: 'native-session-of-the-same-seat',
  });
  const ids = { tool: 'antigravity', model: seat.model, axes: [], kind: 'cli' } as const;
  const identity = 'Google Antigravity CLI · Gemini 3.8 Flash (High)';
  writeSeatIdentities(ref, {
    plan: identity,
    build: identity,
    review: identity,
    ids: { plan: ids, build: ids, review: ids },
  });

  const same = await cli(target, ['continue', ref.sessionId], { timeoutMs: 60_000 });
  expect(same.stderr).toContain('Run readiness blocked');
  expect(same.stderr).not.toContain('seat changed');

  writeConfig(target.projectDir, {
    ...config,
    planner: seat,
    implementer: { ...seat, effort: 'low' },
    reviewer: seat,
  });
  const moved = await cli(target, ['continue', ref.sessionId], { timeoutMs: 60_000 });
  expect(moved.stderr).toContain('BUILD seat changed');
  expect(moved.stderr).not.toContain('PLAN seat changed');
});

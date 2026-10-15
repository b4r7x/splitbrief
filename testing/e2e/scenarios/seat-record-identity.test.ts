import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { PLAN_FILE, REVIEW_FILE, TASKS_FILE, sessionDir } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { readSeatIdentities, writeSeatIdentities } from '../../../src/core/state/seats.js';
import { saveDetectionCache } from '../../../src/engine/detection/cache.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
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

it('uses the remembered catalog name in every run artifact and doctor JSON', async () => {
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
  await saveDetectionCache({
    projectDir: target.projectDir,
    snapshot: {
      contextKey: 'remembered',
      fetchedAt: Date.now(),
      validatedAt: Date.now(),
      generation: 1,
      requestId: 1,
      providers: [],
      cliTools: tools,
      cliCatalogs: [
        {
          tool: 'codex',
          models: [{ id: MODEL, displayName: 'GPT-6-Luna', contextLength: 272_000 }],
          probedAt: Date.now(),
        },
      ],
    },
  });

  const doctor = await cli(target, ['doctor', '--json']);
  expect(JSON.parse(doctor.stdout).report.checks).toContainEqual(
    expect.objectContaining({ summary: 'BUILD OpenAI Codex CLI · GPT-6-Luna configured.' }),
  );
  expect(doctor.stdout).not.toContain('GPT-6 Luna');

  const run = await cli(target, ['start', 'smoke']);
  expect(run.exitCode, run.stderr).toBe(0);
  const [sessionId] = readdirSync(join(target.projectDir, '.splitbrief', 'sessions'));
  if (sessionId === undefined) throw new Error('Expected a run record');
  const ref = { projectDir: target.projectDir, sessionId };

  expect(loadState(ref)?.phase).toBe('complete');
  expect(readSeatIdentities(ref)).toMatchObject({
    build: 'OpenAI Codex CLI · GPT-6-Luna',
    ids: { build: { tool: 'codex', model: MODEL, axes: [], kind: 'cli' } },
  });
  const documents = [PLAN_FILE, TASKS_FILE, REVIEW_FILE, 'review-packet.md', 'seats.json'];
  for (const name of documents) {
    const text = readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), name), 'utf8');
    expect(text, name).toContain('OpenAI Codex CLI · GPT-6-Luna');
    expect(text, name).not.toContain('GPT-6 Luna');
  }
  const seats = readSeatIdentities(ref);
  if (seats === null) throw new Error('Expected a seat record');
  for (const name of [PLAN_FILE, TASKS_FILE, REVIEW_FILE]) {
    const text = readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), name), 'utf8');
    expect(text, name).toContain(`planner: ${seats.plan}\n`);
    expect(text, name).toContain(`implementer: ${seats.build}\n`);
    expect(text, name).toContain(`reviewer: ${seats.review}\n`);
  }

  const spec = await cli(target, ['spec', 'catalog names']);
  expect(spec.exitCode, spec.stderr).toBe(0);
  const specSession = readdirSync(join(target.projectDir, '.splitbrief', 'sessions')).find(
    (id) => id !== sessionId,
  );
  if (specSession === undefined) throw new Error('Expected a planning session');
  for (const name of [PLAN_FILE, TASKS_FILE]) {
    const text = readFileSync(join(sessionDir(target.projectDir, specSession), name), 'utf8');
    expect(text).toContain('implementer: OpenAI Codex CLI · GPT-6-Luna');
    expect(text).toContain(`reviewer: ${seats.review}\n`);
    expect(text).not.toContain('GPT-6 Luna');
  }
});

// Older records kept no axis for a level encoded in the model id.
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
    implementer: { ...seat, model: 'gemini-3.8-flash-low' },
    reviewer: seat,
  });
  const moved = await cli(target, ['continue', ref.sessionId], { timeoutMs: 60_000 });
  expect(moved.stderr).toContain('BUILD seat changed');
  expect(moved.stderr).not.toContain('PLAN seat changed');
});

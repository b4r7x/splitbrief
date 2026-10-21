import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMap, parseDocument } from 'yaml';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { configPath } from '../../../src/core/config/load/document.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readSeatIdentities, seatIdentitiesFromConfig } from '../../../src/core/state/seats.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const PRIMARY_MODEL = 'gpt-5-codex';
const FALLBACK_MODEL = 'gpt-6.1-sol';
const BUILD_REPLY = `mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Implemented the greeting helper.' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } }));`;
let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

function codexFixture(
  body: (target: StopContinueFixture) => string,
  implementerScript?: (() => string) | undefined,
) {
  fixture = createStopContinueFixture(implementerScript ?? (() => ''), { isolation: 'none' });
  const target = fixture;
  trustHome = createTrustHome('e2e-seat-fallback-home');
  mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
  writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  const callsPath = join(target.tmpDir, 'seat-calls.jsonl');
  writeFakeNodeCli(
    binDir,
    'codex',
    `const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
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
const prompt = readFileSync(0, 'utf8');
const model = args[args.indexOf('--model') + 1];
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ model }) + '\\n');
${body(target)}`,
  );
  restorePath = activateSafeCliShimPath(binDir);
  return { target, callsPath };
}

async function runFixture(
  target: StopContinueFixture,
  detection: 'remembered' | 'none' = 'remembered',
) {
  if (detection === 'remembered') {
    const cliTools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['codex'],
      authChannels: { codex: 'session' },
      role: 'implementer',
    });
    expect(cliTools[0]?.diagnostic.state).toBe('ready');
    await rememberDetectedTools(target.projectDir, cliTools);
  }
  const offlinePreload = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePreload,
    "globalThis.fetch = async () => { throw new Error('Network disabled in fallback E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePreload}`);
  const options = {
    timeoutMs: 90_000,
    reapProjectDir: target.projectDir,
  };
  const run = await cli(target, ['start', 'smoke'], options);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const ref = { projectDir: target.projectDir, sessionId: sessions[0] ?? '' };
  const state = loadState(ref);
  return { run, state, ref };
}

function recordedCalls(callsPath: string) {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function plannerBlock(rawYaml: string): string {
  const planner = parseDocument(rawYaml).get('planner', true);
  if (!isMap(planner) || planner.range == null) throw new Error('Expected the planner YAML block');
  return rawYaml.slice(rawYaml.indexOf('planner:'), planner.range[2]);
}

describe('e2e: declared seat fallback', () => {
  it('halts BUILD, switches once, and completes the same run on the fallback model', async () => {
    const { target, callsPath } = codexFixture(
      () => `if (model === ${JSON.stringify(PRIMARY_MODEL)}) {
  console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
  process.exit(1);
}
if (model !== ${JSON.stringify(FALLBACK_MODEL)}) throw new Error('Unexpected model: ' + model);
if (!args.includes('model_reasoning_effort=high')) throw new Error('Expected high effort on the fallback');
${BUILD_REPLY}`,
    );

    const gitignore = readFileSync(join(target.projectDir, '.gitignore'));
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: PRIMARY_MODEL,
        contextLength: 200_000,
        fallback: { tool: 'codex', model: FALLBACK_MODEL, effort: 'high' },
      },
    });
    expect(readFileSync(join(target.projectDir, '.gitignore'))).toEqual(gitignore);
    const { run, state, ref } = await runFixture(target);
    expect(
      run.exitCode,
      `${run.stdout}\n${run.stderr}\n${JSON.stringify(state?.pendingRecovery, null, 2)}`,
    ).toBe(0);
    expect(run.stdout).toContain('task T001: done');
    expect(state?.phase).toBe('complete');
    expect(state?.pendingRecovery).toBeUndefined();
    expect(state?.tasks[0]?.status).toBe('done');
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/seat changed/);
    expect(readSeatIdentities(ref)).toEqual(
      seatIdentitiesFromConfig(loadConfig(target.projectDir).config),
    );
    expect(state?.seatSwitches).toEqual([
      expect.objectContaining({
        seat: 'build',
        from: 'OpenAI Codex CLI · GPT-5 Codex',
        to: 'OpenAI Codex CLI · GPT-6.1-Sol · high',
        cause: 'runner-usage-limit',
        auto: true,
      }),
    ]);
    expect(recordedCalls(callsPath)).toEqual([{ model: PRIMARY_MODEL }, { model: FALLBACK_MODEL }]);
    expect(loadConfig(target.projectDir).config.implementer).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      model: FALLBACK_MODEL,
      effort: 'high',
      fallback: { tool: 'codex', model: PRIMARY_MODEL },
    });
    const rawYaml = readFileSync(configPath(target.projectDir), 'utf8');
    const implementer = parseDocument(rawYaml).get('implementer', true);
    if (!isMap(implementer) || implementer.range == null) {
      throw new Error('Expected the implementer YAML block');
    }
    expect(
      rawYaml.slice(rawYaml.indexOf('implementer:'), implementer.range[2]).split('\n'),
    ).toEqual([
      'implementer:',
      '  kind: cli',
      '  tool: codex',
      `  model: ${FALLBACK_MODEL}`,
      '  effort: high',
      '  context_length: 200000',
      '  fallback:',
      '    tool: codex',
      `    model: ${PRIMARY_MODEL}`,
      '',
    ]);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(join(target.projectDir, '.gitignore'))).toEqual(gitignore);
  });

  it('switches BUILD to its fallback when the project remembers no detection', async () => {
    const { target, callsPath } = codexFixture(
      () => `if (model === ${JSON.stringify(PRIMARY_MODEL)}) {
  console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
  process.exit(1);
}
if (model !== ${JSON.stringify(FALLBACK_MODEL)}) throw new Error('Unexpected model: ' + model);
${BUILD_REPLY}`,
    );
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: PRIMARY_MODEL,
        contextLength: 200_000,
        fallback: { tool: 'codex', model: FALLBACK_MODEL },
      },
    });
    expect(existsSync(join(target.projectDir, '.splitbrief', 'detection-cache.json'))).toBe(false);

    const { run, state } = await runFixture(target, 'none');

    expect(
      run.exitCode,
      `${run.stdout}\n${run.stderr}\n${JSON.stringify(state?.pendingRecovery, null, 2)}`,
    ).toBe(0);
    expect(state?.phase).toBe('complete');
    expect(state?.seatSwitches).toEqual([
      expect.objectContaining({ seat: 'build', cause: 'runner-usage-limit', auto: true }),
    ]);
    expect(recordedCalls(callsPath)).toEqual([{ model: PRIMARY_MODEL }, { model: FALLBACK_MODEL }]);
  });

  it('switches inherited REVIEW using PLAN fallback and preserves the planner YAML bytes', async () => {
    const { target, callsPath } = codexFixture(
      () => `const reviewing = prompt.includes('Final Implementation Review');
if (reviewing && model === ${JSON.stringify(PRIMARY_MODEL)}) {
  console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
  process.exit(1);
}
if (model !== (reviewing ? ${JSON.stringify(FALLBACK_MODEL)} : ${JSON.stringify(PRIMARY_MODEL)})) {
  throw new Error('Unexpected model: ' + model);
}
const { spawnSync } = require('node:child_process');
const reply = spawnSync(process.execPath, ['./tools/planner.mjs'], { input: prompt, encoding: 'utf8' });
if (reply.status !== 0) throw new Error(reply.stderr);
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply.stdout } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } }));`,
      () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log('Implemented the greeting helper.');`,
    );
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      planner: {
        kind: 'cli',
        tool: 'codex',
        model: PRIMARY_MODEL,
        fallback: { tool: 'codex', model: FALLBACK_MODEL },
      },
    });
    const file = configPath(target.projectDir);
    const rawYaml = readFileSync(file, 'utf8').replace(
      'planner:\n',
      'planner:\n  # PLAN keeps this comment\n',
    );
    writeFileSync(file, rawYaml);
    const plannerBefore = loadConfig(target.projectDir).config.planner;
    expect(loadConfig(target.projectDir).config.reviewer).toBeUndefined();

    const { run, state, ref } = await runFixture(target);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state?.phase).toBe('complete');
    expect(state?.pendingRecovery).toBeUndefined();
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/seat changed/);
    expect(readSeatIdentities(ref)).toEqual(
      seatIdentitiesFromConfig(loadConfig(target.projectDir).config),
    );
    expect(state?.seatSwitches).toEqual([
      expect.objectContaining({
        seat: 'review',
        from: 'OpenAI Codex CLI · GPT-5 Codex',
        to: 'OpenAI Codex CLI · GPT-6.1-Sol',
        auto: true,
      }),
    ]);
    expect(recordedCalls(callsPath)).toEqual([
      { model: PRIMARY_MODEL },
      { model: PRIMARY_MODEL },
      { model: FALLBACK_MODEL },
    ]);
    const recorded = loadConfig(target.projectDir).config;
    expect(recorded.reviewer).toEqual({
      kind: 'cli',
      tool: 'codex',
      model: FALLBACK_MODEL,
      fallback: { tool: 'codex', model: PRIMARY_MODEL },
    });
    expect(recorded.planner).toEqual(plannerBefore);
    const recordedYaml = readFileSync(file, 'utf8');
    expect(plannerBlock(recordedYaml)).toBe(plannerBlock(rawYaml));
    expect(recordedYaml).toContain('planner:\n  # PLAN keeps this comment');
  });

  it('applies a fallback saved by the primary call before its next halt', async () => {
    const { target, callsPath } = codexFixture(
      (target) => `if (model === ${JSON.stringify(PRIMARY_MODEL)}) {
  const file = ${JSON.stringify(configPath(target.projectDir))};
  const rawYaml = readFileSync(file, 'utf8');
  if (rawYaml.includes('fallback:')) throw new Error('The run must start without a fallback');
  writeFileSync(file, rawYaml.replace('implementer:\\n', 'implementer:\\n  fallback:\\n    tool: codex\\n    model: ${FALLBACK_MODEL}\\n'));
  console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
  process.exit(1);
}
if (model !== ${JSON.stringify(FALLBACK_MODEL)}) throw new Error('Unexpected model: ' + model);
${BUILD_REPLY}`,
    );
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer: { kind: 'cli', tool: 'codex', model: PRIMARY_MODEL, contextLength: 200_000 },
    });
    expect(loadConfig(target.projectDir).config.implementer.fallback).toBeUndefined();

    const { run, state } = await runFixture(target);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state?.phase).toBe('complete');
    expect(state?.pendingRecovery).toBeUndefined();
    expect(state?.seatSwitches).toEqual([
      expect.objectContaining({ seat: 'build', auto: true, to: 'OpenAI Codex CLI · GPT-6.1-Sol' }),
    ]);
    expect(recordedCalls(callsPath)).toEqual([{ model: PRIMARY_MODEL }, { model: FALLBACK_MODEL }]);
    expect(loadConfig(target.projectDir).config.implementer).toEqual({
      kind: 'cli',
      tool: 'codex',
      model: FALLBACK_MODEL,
      contextLength: 200_000,
      fallback: { tool: 'codex', model: PRIMARY_MODEL },
    });
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  });

  it('keeps the halt pending when the primary call leaves an invalid config', async () => {
    const invalidYaml = 'version: 3\nplanner:\n  kind: cli\n  tool: invalid-tool\n';
    const { target, callsPath } = codexFixture(
      (
        target,
      ) => `writeFileSync(${JSON.stringify(configPath(target.projectDir))}, ${JSON.stringify(invalidYaml)});
console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
process.exit(1);`,
    );
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: PRIMARY_MODEL,
        contextLength: 200_000,
        fallback: { tool: 'codex', model: FALLBACK_MODEL },
      },
    });

    const { run, state } = await runFixture(target);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(state?.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      status: 'awaiting-user',
    });
    expect(state?.pendingRecovery?.details).toContain(
      'fallback: not read · config.yaml does not load',
    );
    expect(state?.seatSwitches ?? []).toEqual([]);
    expect(recordedCalls(callsPath)).toEqual([{ model: PRIMARY_MODEL }]);
    expect(readFileSync(configPath(target.projectDir), 'utf8')).toBe(invalidYaml);
  });
});

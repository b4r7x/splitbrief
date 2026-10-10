import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { PLAN_JSON_FILE, sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { HeadlessJsonRecordSchema } from '../../../src/engine/events/public-json.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { installClaudeStreamFragmentsShim } from '../helpers/claude-stream-fragments-shim.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import { buildSteeringCli } from '../helpers/steer-e2e-workflow.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

beforeAll(buildSteeringCli, 120_000);

it('emits every Claude planner tool fragment and one subagent answer through the built CLI', async () => {
  const target = createStopContinueFixture(
    () => `
import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  const home = useTrustHome('claude-stream-fragments-home');
  let restorePath: (() => void) | undefined;
  try {
    mkdirSync(join(home.home, '.claude'), { recursive: true });
    writeFileSync(join(home.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    const bin = join(target.tmpDir, 'bin');
    mkdirSync(bin);
    installClaudeStreamFragmentsShim(bin);
    restorePath = activateSafeCliShimPath(bin);
    const config = loadConfig(target.projectDir).config;
    const claude = { kind: 'cli', tool: 'claude-code', model: 'sonnet' } as const;
    writeConfig(target.projectDir, {
      ...config,
      planner: claude,
      reviewer: claude,
      workflow: { ...config.workflow, git: { createBranch: false } },
    });
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['claude-code'],
      authChannels: { 'claude-code': 'session' },
      role: 'planner',
    });
    expect(tools[0]?.diagnostic.state, JSON.stringify(tools[0]?.diagnostic)).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in Claude fragments E2E'); };\n",
    );
    const outcome = await spawnCli({
      args: [
        '--import',
        offline,
        'dist/cli.js',
        'start',
        'smoke',
        '--json',
        '--allow-repo-runners',
        '--project',
        target.projectDir,
      ],
      stateHome: target.stateHome,
      timeoutMs: 60_000,
      reapProjectDir: target.projectDir,
    });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    const events = outcome.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonRecordSchema.parse(JSON.parse(line)))
      .flatMap((record) => (record.type === 'event' ? [record.data] : []));
    expect(events).toContainEqual(expect.objectContaining({ type: 'workflow_complete' }));
    const fragments = ['{"file_path":"src/hello', ' world.ts"}'];
    const toolDeltas = events
      .filter((event) => event.type === 'runner_call_tool_use')
      .filter((event) => event.stage === 'delta')
      .filter((event) => fragments.includes(event.inputDelta));
    expect(toolDeltas).toEqual(
      fragments.map((inputDelta) =>
        expect.objectContaining({
          phase: 'planning',
          toolUseId: 'tool-read',
          name: 'Read',
          inputDelta,
        }),
      ),
    );
    expect(toolDeltas.map((event) => event.inputDelta).join('')).toBe(
      '{"file_path":"src/hello world.ts"}',
    );
    const subagentAnswer = 'CLAUDE_FRAGMENT_SUBAGENT_ANSWER';
    expect(
      events.filter(
        (event) => event.type === 'runner_call_text_delta' && event.text === subagentAnswer,
      ),
    ).toEqual([
      expect.objectContaining({
        phase: 'planning',
        channel: 'assistant',
        subagentId: 'agent-1',
      }),
    ]);
    const sessionIds = readdirSync(sessionsRoot(target.projectDir));
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0];
    if (sessionId === undefined) throw new Error('CLI started without a run session');
    expect(
      readFileSync(join(sessionDir(target.projectDir, sessionId), PLAN_JSON_FILE), 'utf8'),
    ).not.toContain(subagentAnswer);
    expect(loadState({ projectDir: target.projectDir, sessionId })).toMatchObject({
      phase: 'complete',
      reviewStatus: 'passed',
      tasks: [{ id: 'T001', status: 'done' }],
    });
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
  } finally {
    restorePath?.();
    home.restore();
    cleanupTempDir(target.tmpDir);
  }
});

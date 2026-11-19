import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { runApplyAtRest } from '../../../src/engine/orchestrator/apply/at-rest.js';
import { withAttemptRestoreScope } from '../../../src/engine/orchestrator/task/restore-scope.js';
import { type ApplyRun, endApplyRun, openApplyRun } from '#testing/helpers/apply-run.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeWorkflowState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  PLAN_ANSWER,
} from '../helpers/stop-continue-fixture.js';

const FOREIGN_FILE = 'sibling.txt';
const PLANNER_FILE = 'unexpected-planner-write.txt';

const FOREIGN_BYTES = 'sibling build\n';

async function applySibling(run: ApplyRun): Promise<void> {
  const ref = { projectDir: run.dir, sessionId: run.sessionId };
  const state = makeWorkflowState({
    ...RUN_CREW,
    phase: 'complete',
    reviewStatus: 'passed',
    workspace: run.workspace,
  });
  saveState(ref, state);
  const result = await runApplyAtRest({
    wctx: { ...ref, bus: createEventBus() },
    state,
    reviewNone: true,
  });
  expect(result).toMatchObject({ outcome: 'applied', files: [FOREIGN_FILE] });
}

it.each([
  {
    name: 'lets a read-only CLI planner finish after a sibling Apply',
    apply: true,
    unauthorized: false,
  },
  { name: 'still rejects a planner write after a sibling Apply', apply: true, unauthorized: true },
  {
    name: 'still rejects a planner write during an opaque sibling call',
    apply: false,
    unauthorized: true,
  },
])('$name', async ({ apply, unauthorized }) => {
  const fixture = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});`,
    { isolation: 'none' },
  );
  const { tmpDir, projectDir } = fixture;
  const started = join(tmpDir, 'planner-started');
  const release = join(tmpDir, 'release-planner');
  const plannerWrote = join(tmpDir, 'planner-wrote');
  const reply = join(tmpDir, 'reply');
  const binDir = join(tmpDir, 'bin');
  mkdirSync(binDir);
  const trust = useTrustHome('e2e-foreign-write-home');
  mkdirSync(join(trust.home, '.codex'));
  writeFileSync(join(trust.home, '.codex', 'auth.json'), '{"fixture":true}\n');
  const restorePath = activateSafeCliShimPath(binDir);
  writeFakeNodeCli(
    binDir,
    'codex',
    `
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (!args.includes('exec')) throw new Error('Unexpected Codex invocation');
readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(started)}, '');
const hold = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  if (${unauthorized} && !existsSync(${JSON.stringify(plannerWrote)})) {
    writeFileSync(${JSON.stringify(PLANNER_FILE)}, ${JSON.stringify('planner\n')});
    writeFileSync(${JSON.stringify(plannerWrote)}, '');
  }
  if (!existsSync(${JSON.stringify(reply)})) return;
  clearInterval(hold);
  const emit = (entry) => console.log(JSON.stringify(entry));
  emit({ type: 'thread.started', thread_id: 'planner-with-sibling' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(JSON.stringify(PLAN_ANSWER))} } });
  emit({ type: 'turn.completed' });
}, 10);`,
  );
  const offline = join(tmpDir, 'offline.mjs');
  writeFileSync(offline, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
  vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);
  const config = loadConfig(projectDir).config;
  writeConfig(projectDir, {
    ...config,
    planner: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
    reviewer: 'none',
  });
  const siblingRef = { projectDir, sessionId: 'sibling-run' };
  const sibling = apply ? await openApplyRun(projectDir, siblingRef) : undefined;
  if (sibling !== undefined) writeFileSync(join(sibling.ws, FOREIGN_FILE), FOREIGN_BYTES);
  const running = cli(fixture, ['start', 'Add a greeting helper'], { timeoutMs: 60_000 });
  let exited: Awaited<typeof running> | undefined;
  void running.then((result) => {
    exited = result;
  });
  try {
    await vi.waitFor(
      () => {
        if (exited === undefined) expect(existsSync(started)).toBe(true);
      },
      { timeout: 25_000 },
    );
    expect(exited, `${exited?.stdout}\n${exited?.stderr}`).toBeUndefined();
    if (sibling !== undefined) {
      await applySibling(sibling);
      writeFileSync(release, '');
    } else {
      await withAttemptRestoreScope({
        ref: siblingRef,
        dir: projectDir,
        taskStartSnapshot: null,
        run: async () => {
          writeFileSync(join(projectDir, FOREIGN_FILE), FOREIGN_BYTES);
          writeFileSync(release, '');
          await vi.waitFor(() => expect(existsSync(plannerWrote)).toBe(true));
        },
      });
    }
    writeFileSync(reply, '');
    const result = await running;
    const output = `${result.stdout}\n${result.stderr}`;
    if (apply) expect(output).not.toContain(`unexpected filesystem mutations: ${FOREIGN_FILE}`);
    if (unauthorized) {
      expect(result.exitCode, output).toBe(1);
      expect(output).toContain(
        `unexpected filesystem mutations: ${apply ? PLANNER_FILE : `${FOREIGN_FILE}, ${PLANNER_FILE}`}`,
      );
    } else {
      expect(result.exitCode, output).toBe(0);
      expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
    }
    expect(readFileSync(join(projectDir, FOREIGN_FILE), 'utf8')).toBe(FOREIGN_BYTES);
  } finally {
    writeFileSync(release, '');
    writeFileSync(reply, '');
    await running;
    if (sibling !== undefined) endApplyRun(sibling);
    vi.unstubAllEnvs();
    restorePath();
    trust.restore();
    cleanupTempDir(tmpDir);
  }
});

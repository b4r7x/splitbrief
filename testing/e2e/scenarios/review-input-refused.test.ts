import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { applyRecoveryAction } from '../../../src/engine/orchestrator/recovery/actions.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import { factSpans, runRows } from '../../../src/features/workflow/closed/copy.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
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

const IMPLEMENTER_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

/**
 * Claude Code as the review seat. It refuses the final review the way it refused an oversized
 * review live: an `is_error` result that says only "Prompt is too long", and exit 1.
 */
function installRefusingClaude(binDir: string, reviewCalls: string): void {
  writeFakeNodeCli(
    binDir,
    'claude',
    `const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
const emit = (entry) => console.log(JSON.stringify(entry));
const answer = (prompt) => {
  emit({ type: 'system', subtype: 'init', session_id: 'review-too-long' });
  if (prompt.includes('Final Implementation Review')) {
    appendFileSync(${JSON.stringify(reviewCalls)}, 'review\\n');
    emit({ type: 'result', is_error: true, result: 'Prompt is too long', session_id: 'review-too-long', usage: { input_tokens: 0, output_tokens: 0 } });
    process.exitCode = 1;
    return;
  }
  emit({ type: 'result', result: 'Summary complete', session_id: 'review-too-long', usage: { input_tokens: 10, output_tokens: 5 } });
};
if (args.includes('--input-format')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    const content = JSON.parse(line).message.content;
    answer(typeof content === 'string' ? content : JSON.stringify(content));
    lines.close();
    process.stdin.destroy();
  });
} else {
  answer(readFileSync(0, 'utf8'));
}`,
  );
}

describe('e2e: the review tool refuses its input as too long', { timeout: 240_000 }, () => {
  it('halts with Skip review and End run, no Try again, Skip review makes the run ready to apply, and the ended run says its review got no verdict', async () => {
    fixture = createStopContinueFixture(() => IMPLEMENTER_SCRIPT, { isolation: 'worktree' });
    const target = fixture;
    trustHome = useTrustHome('e2e-review-refused-home');
    mkdirSync(join(trustHome.home, '.claude'), { recursive: true });
    writeFileSync(join(trustHome.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    const binDir = join(target.tmpDir, 'bin');
    mkdirSync(binDir);
    const reviewCalls = join(target.tmpDir, 'review-calls');
    installRefusingClaude(binDir, reviewCalls);
    restorePath = activateSafeCliShimPath(binDir);

    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      reviewer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['claude-code'],
      authChannels: { 'claude-code': 'session' },
    });
    expect(tools[0]?.diagnostic.state, JSON.stringify(tools[0]?.diagnostic)).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in review refusal E2E'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);

    const halted = await cli(target, ['start', 'smoke'], { timeoutMs: 120_000 });
    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error(`the run left no session: ${halted.stderr}`);
    const haltState = readState(target, sessionId);

    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(halted.stderr).toContain('(review-input-too-large)');
    const issue = haltState.pendingRecovery;
    expect(issue?.reason).toBe('review-input-too-large');
    expect(issue?.availableActions).toEqual(['accept-as-is', 'end-run']);
    expect(issue?.availableActions).not.toContain('retry-same-worker');
    expect(issue?.message).toMatch(
      /^Review input is [\d,]+ characters; .+ refused it as too large$/,
    );
    // The refusal is a halt on the first call: nothing sent the same prompt again.
    expect(readFileSync(reviewCalls, 'utf8')).toBe('review\n');

    const projectDir = await canonicalizeProjectDir({ project: target.projectDir });
    vi.stubEnv('XDG_STATE_HOME', target.stateHome);
    const skipped = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: haltState,
      action: 'accept-as-is',
      comment: plainUserMessage('Fixtures too big.'),
      bus: createRecoveryBus({ projectDir, sessionId }),
      config: loadConfig(projectDir).config,
    });
    expect(skipped.ok, skipped.ok ? '' : skipped.message).toBe(true);

    const ready = readState(target, sessionId);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: true,
    });
    expect(ready.acceptedAsIs?.findings).toEqual([issue?.message]);
    expect(ready.acceptedAsIs?.note).toBe('Fixtures too big.');
    expect(existsSync(join(target.projectDir, GREET_FILE))).toBe(false);

    const ended = await cli(target, ['continue', sessionId, '--action', 'end-run']);
    expect(ended.exitCode, ended.stderr).toBe(0);
    const view = deriveSummaryView({ record: readRunRecord({ projectDir, sessionId }) });
    if (view === null) throw new Error('the ended run has no closed view');
    const review = runRows(view).find((row) => row.label === 'Review');
    expect(review?.segments.flatMap(factSpans).map((span) => span.text)).toEqual([
      'final review no verdict',
    ]);
  });
});

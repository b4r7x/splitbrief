import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { installClaudeStreamFragmentsShim } from '../helpers/claude-stream-fragments-shim.js';
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
let home: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  home?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  home = undefined;
});

describe('e2e: a brief that links .splitbrief out of the run workspace', () => {
  it('stops the final review before the reviewer reads the change, and writes no change outside', {
    timeout: 240_000,
  }, async () => {
    let outside = '';
    fixture = createStopContinueFixture((projectDir) => {
      outside = join(projectDir, '..', 'outside');
      return `
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
mkdirSync(${JSON.stringify(outside)}, { recursive: true });
rmSync('.splitbrief', { recursive: true, force: true });
symlinkSync(${JSON.stringify(outside)}, '.splitbrief');
`;
    });
    const target = fixture;
    home = useTrustHome('review-change-file-confined-home');
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
      pathEnv: process.env.PATH ?? '',
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
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: 120_000 });

    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('the run saved no session');
    expect(run.exitCode, run.stdout).toBe(1);
    expect(run.stderr).toContain(
      `Error: Needs you (review-failed): Final review failed (reviewer: Claude Code CLI): unsafe path: path escapes root directory: .splitbrief/reviews/${sessionId}.diff`,
    );
    expect(run.stdout).toContain('review: no verdict\n');
    expect(run.stdout).not.toContain('review: passed');
    expect(existsSync(join(outside, 'reviews', `${sessionId}.diff`))).toBe(false);
    const state = loadState({ projectDir: target.projectDir, sessionId });
    expect(state).toMatchObject({ phase: 'final-review', tasks: [{ id: 'T001', status: 'done' }] });
    expect(state?.reviewStatus).toBeUndefined();
  });
});

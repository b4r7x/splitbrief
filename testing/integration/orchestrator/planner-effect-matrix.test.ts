import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableReceipt } from '../../../src/core/discovery/detection.js';
import { ConfigSchema, type Config } from '../../../src/core/schemas/config.js';
import type { RunnerCallEvent } from '../../../src/engine/calls/types.js';
import { createPlanner } from '../../../src/engine/runners/factory.js';
import { CLI_CONFORMANCE_EXIT_CODES } from '../../../src/engine/runners/cli-tools/contract-harness.js';
import { runFactoryEffectConformance } from '../../../src/engine/runners/cli-tools/contract-harness-effects.js';
import { admitCandidateEffect } from '../../../src/engine/providers/candidate-contract.js';
import type { RunnerGate } from '../../../src/engine/runners/prepared-execution.js';
import {
  effectScenario,
  fixtureExecutable,
  gitStatus,
  runEffect,
  seedHostileConfig,
} from '#testing/helpers/factories/cli-effect-fixture.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import { cleanupTempDir, createTempDir, normalizeMacTmpPath } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

const NONCE = 'nonce-\u03b1\u03b2-\u2713-\ud83d\ude80-7f3a9c11';
const SENTINEL_A = 'final-\u03b1\u03b2-\u2713-\ud83d\ude80-sentinel-A';
const SENTINEL_B = 'final-\u03b1\u03b2-\u2713-\ud83d\ude80-sentinel-B';

function effectConfig(timeoutMs?: number): Config {
  return ConfigSchema.parse({
    version: 3,
    planner: {
      kind: 'cli',
      tool: 'opencode',
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
    },
    implementer: {
      kind: 'cli',
      tool: 'opencode',
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
    },
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: {
      maxRetries: 0,
      persistTranscript: false,
      mode: 'instant',
      taskReview: 'none',
      compactionFormat: 'auto',
    },
  });
}

function plannerAuthority(receipt: CliExecutableReceipt) {
  const slot = { role: 'planner' } as const;
  const preparationId = 'effect-matrix-planner';
  const gates: readonly RunnerGate[] = [
    { kind: 'cli', slot, preparationId, tool: 'opencode', executable: receipt },
  ];
  return { slot, preparationId, gates };
}

function finalResponseBody(): string {
  const draft = JSON.stringify({ type: 'text', part: { type: 'text', text: 'draft bytes' } });
  const toolUse = JSON.stringify({
    type: 'tool_use',
    part: {
      tool: 'read',
      id: 'read_0',
      name: 'read',
      state: { status: 'completed', input: { file: 'x' }, output: 'tool out' },
    },
  });
  const sentinelA = JSON.stringify({ type: 'text', part: { type: 'text', text: SENTINEL_A } });
  const sentinelB = JSON.stringify({ type: 'text', part: { type: 'text', text: SENTINEL_B } });
  return [
    `printf '%s\\n' '${draft}'`,
    `printf '%s\\n' '${toolUse}'`,
    'for last; do :; done',
    'case "$last" in',
    `  *'first'*) printf '%s\\n' '${sentinelA}' ;;`,
    `  *) printf '%s\\n' '${sentinelB}' ;;`,
    'esac',
    'exit 0',
  ].join('\n');
}

describe('planner effect matrix — production factories under hostile config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns only the current call final response bytes, byte-identical, under hostile host config', async () => {
    const scenario = await effectScenario('effect-matrix-final-response');
    const hostileHome = createTempDir('effect-matrix-hostile-home');
    const hostileXdg = createTempDir('effect-matrix-hostile-xdg');
    try {
      await seedHostileConfig({ projectDir: scenario.projectDir, hostileHome, hostileXdg });
      vi.stubEnv('HOME', hostileHome);
      vi.stubEnv('XDG_CONFIG_HOME', hostileXdg);
      vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
      const receipt = await fixtureExecutable({
        directory: scenario.toolsDir,
        body: finalResponseBody(),
      });
      const authority = plannerAuthority(receipt);
      const config = effectConfig();
      const planner = await createPlanner(config, {
        preparedConfig: config,
        ...authority,
        initialSessionId: null,
      });

      const events: RunnerCallEvent[] = [];
      const first = await planner.review('review the staged plan first', scenario.projectDir, {
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      });
      const second = await planner.review('review the staged plan second', scenario.projectDir, {
        onOutput: () => {},
      });

      expect(first.text).toBe(SENTINEL_A);
      expect(second.text).toBe(SENTINEL_B);
      const deltas = events.filter((event) => event.type === 'call_text_delta');
      expect(deltas.some((event) => event.text === 'draft bytes')).toBe(true);
      expect(deltas.findLast((event) => event.channel === 'result')).toMatchObject({
        channel: 'result',
        text: SENTINEL_A,
        semantics: 'final',
      });
    } finally {
      cleanupTempDir(hostileHome);
      cleanupTempDir(hostileXdg);
      await scenario.cleanup();
    }
  });

  it('keeps the authoritative checkout byte-identical while denying host, external, and sibling paths', async () => {
    const scenario = await effectScenario('effect-matrix-denial');
    const hostileHome = createTempDir('effect-matrix-hostile-home');
    const hostileXdg = createTempDir('effect-matrix-hostile-xdg');
    const siblingDir = createTempDir('effect-matrix-sibling');
    try {
      createTestGitRepo(siblingDir, { 'marker.txt': 'sibling-marker\n' });
      await seedHostileConfig({ projectDir: scenario.projectDir, hostileHome, hostileXdg });
      vi.stubEnv('HOME', hostileHome);
      vi.stubEnv('XDG_CONFIG_HOME', hostileXdg);
      vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
      const marker = join(scenario.toolsDir, 'env.txt');
      const outside = join(scenario.toolsDir, 'outside-leak.txt');
      const siblingLeak = join(siblingDir, 'leak.txt');
      const body = [
        `printf '%s' 'host-leak' > "$HOME/host-leak.txt"`,
        `printf '%s' 'outside-leak' > '${outside}'`,
        `printf '%s' 'sibling-leak' > '${siblingLeak}'`,
        `printf '%s\\n' "$HOME|$TMPDIR|$XDG_CONFIG_HOME|$XDG_CACHE_HOME" > '${marker}'`,
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"ok"}}'`,
        'exit 0',
      ].join('\n');
      const receipt = await fixtureExecutable({ directory: scenario.toolsDir, body });
      const authority = plannerAuthority(receipt);
      const config = effectConfig();
      const planner = await createPlanner(config, {
        preparedConfig: config,
        ...authority,
        initialSessionId: null,
      });

      const result = await planner.review('review the staged plan', scenario.projectDir, {
        onOutput: () => {},
      });
      expect(result.text).toBe('ok');

      const envLine = readFileSync(marker, 'utf8').split('\n')[0] ?? '';
      const [home, tmpdir, xdgConfig, xdgCache] = envLine.split('|');
      const projectReal = normalizeMacTmpPath(realpathSync(scenario.projectDir)) ?? '';
      for (const value of [home ?? '', tmpdir ?? '', xdgConfig ?? '', xdgCache ?? '']) {
        expect(normalizeMacTmpPath(value)?.startsWith(projectReal)).toBe(true);
      }
      expect(normalizeMacTmpPath(home ?? '')).not.toBe(normalizeMacTmpPath(hostileHome));
      expect(await gitStatus(scenario.projectDir)).toEqual([]);
      expect(await readFile(join(siblingDir, 'marker.txt'), 'utf8')).toBe('sibling-marker\n');
      expect(existsSync(outside)).toBe(true);
    } finally {
      cleanupTempDir(hostileHome);
      cleanupTempDir(hostileXdg);
      cleanupTempDir(siblingDir);
      await scenario.cleanup();
    }
  });

  it('rejects a planner that changes git metadata as a staged mutation', async () => {
    const scenario = await effectScenario('effect-matrix-git');
    try {
      const outcome = await runEffect({
        role: 'planner',
        body: "printf 'mutated\\n' > src/committed.ts\n git add src/committed.ts\n git -c user.name=matrix -c user.email=matrix@fixture.local commit --quiet -m 'planner commit'\n exit 0",
        effect: { kind: 'planner-read-only' },
        ...scenario,
      });
      expect(outcome.verdict).toBe('OMIT');
      expect(outcome.reason).toMatch(/mutated the staged project/);
      const record = JSON.parse(await readFile(scenario.recordPath, 'utf8')) as {
        changedFiles: string[];
      };
      expect(record.changedFiles).toContain('src/committed.ts');
    } finally {
      await scenario.cleanup();
    }
  });

  it('passes a clean planner under hostile project config with the staged tree untouched', async () => {
    const scenario = await effectScenario('effect-matrix-hostile-clean');
    const hostileHome = createTempDir('effect-matrix-hostile-home');
    const hostileXdg = createTempDir('effect-matrix-hostile-xdg');
    try {
      await seedHostileConfig({ projectDir: scenario.projectDir, hostileHome, hostileXdg });
      vi.stubEnv('HOME', hostileHome);
      vi.stubEnv('XDG_CONFIG_HOME', hostileXdg);
      const outcome = await runEffect({
        role: 'planner',
        body: 'exit 0',
        effect: { kind: 'planner-read-only' },
        ...scenario,
      });
      expect(outcome).toMatchObject({
        exitCode: CLI_CONFORMANCE_EXIT_CODES.PASS,
        verdict: 'PASS',
        role: 'planner',
      });
      expect(await gitStatus(scenario.projectDir)).toEqual([]);
    } finally {
      cleanupTempDir(hostileHome);
      cleanupTempDir(hostileXdg);
      await scenario.cleanup();
    }
  });

  it('passes the implementer only for exactly one nonce-bearing edit at the declared staged path', async () => {
    const scenario = await effectScenario('effect-matrix-implementer');
    const hostileHome = createTempDir('effect-matrix-hostile-home');
    const hostileXdg = createTempDir('effect-matrix-hostile-xdg');
    try {
      await seedHostileConfig({ projectDir: scenario.projectDir, hostileHome, hostileXdg });
      vi.stubEnv('HOME', hostileHome);
      vi.stubEnv('XDG_CONFIG_HOME', hostileXdg);
      const outcome = await runEffect({
        role: 'implementer',
        body: `mkdir -p src\nprintf '%s' '${NONCE}' > src/hello.ts\nexit 0`,
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...scenario,
      });
      expect(outcome).toEqual({
        exitCode: CLI_CONFORMANCE_EXIT_CODES.PASS,
        verdict: 'PASS',
        candidateId: 'opencode',
        role: 'implementer',
      });
      const content = await readFile(join(scenario.projectDir, 'src', 'hello.ts'), 'utf8');
      expect(content).toBe(NONCE);
      expect(await gitStatus(scenario.projectDir)).toEqual(['?? src/hello.ts']);
    } finally {
      cleanupTempDir(hostileHome);
      cleanupTempDir(hostileXdg);
      await scenario.cleanup();
    }
  });

  it('rejects an implementer whose only write lands in the disposable sandbox home', async () => {
    const scenario = await effectScenario('effect-matrix-home-denial');
    try {
      const outcome = await runEffect({
        role: 'implementer',
        body: "printf '%s' 'fallback' > \"$HOME/disposable.txt\"\nexit 0",
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...scenario,
      });
      expect(outcome.verdict).toBe('OMIT');
      expect(outcome.reason).toMatch(/without changing any files|no staged-project change/i);
    } finally {
      await scenario.cleanup();
    }
  });

  it('records the executable drift refusal in the effect-conformance record', async () => {
    const scenario = await effectScenario('effect-matrix-drift');
    try {
      vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
      const receipt = await fixtureExecutable({ directory: scenario.toolsDir, body: 'exit 0' });
      await writeFile(join(scenario.toolsDir, 'opencode'), '\n# drifted\n', { flag: 'a' });
      await runFactoryEffectConformance({
        role: 'planner',
        projectDir: scenario.projectDir,
        prompt: 'review the staged plan',
        executable: receipt,
        effect: { kind: 'planner-read-only' },
        recordPath: scenario.recordPath,
      });
      const record = JSON.parse(await readFile(scenario.recordPath, 'utf8')) as {
        role: string;
        verdict: string;
        reason: string;
        changedFiles: string[];
      };
      expect(record).toMatchObject({ role: 'planner', verdict: 'OMIT', changedFiles: [] });
      expect(record.reason).toMatch(/identity/i);
    } finally {
      await scenario.cleanup();
    }
  });

  it('refuses opposite-role effects: an implementer must write, a planner must not', async () => {
    const plannerScenario = await effectScenario('effect-matrix-role-planner');
    try {
      const outcome = await runEffect({
        role: 'planner',
        body: "mkdir -p src\nprintf '%s' 'x' > src/hello.ts\nexit 0",
        effect: { kind: 'planner-read-only' },
        ...plannerScenario,
      });
      expect(outcome.verdict).toBe('OMIT');
      expect(outcome.reason).toMatch(/mutated the staged project/);
    } finally {
      await plannerScenario.cleanup();
    }

    const implementerScenario = await effectScenario('effect-matrix-role-implementer');
    try {
      const outcome = await runEffect({
        role: 'implementer',
        body: 'exit 0',
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...implementerScenario,
      });
      expect(outcome.verdict).toBe('OMIT');
      expect(outcome.reason).toMatch(/without changing any files|no staged-project change/i);
    } finally {
      await implementerScenario.cleanup();
    }
  });

  it('admits candidates only for the exact observed role and effect', () => {
    const plannerPass = {
      candidateId: 'opencode',
      role: 'planner' as const,
      verdict: 'PASS' as const,
      exitCode: 0,
      changedFiles: [] as string[],
    };
    expect(admitCandidateEffect({ receipt: plannerPass, role: 'planner' })).toMatchObject({
      admitted: true,
    });
    expect(
      admitCandidateEffect({
        receipt: plannerPass,
        role: 'implementer',
        declaredFile: 'src/hello.ts',
      }),
    ).toMatchObject({ admitted: false });
    expect(
      admitCandidateEffect({ receipt: { ...plannerPass, verdict: 'OMIT' }, role: 'planner' }),
    ).toMatchObject({ admitted: false });
    const implementerPass = {
      ...plannerPass,
      role: 'implementer' as const,
      changedFiles: ['src/hello.ts'],
    };
    expect(
      admitCandidateEffect({
        receipt: implementerPass,
        role: 'implementer',
        declaredFile: 'src/hello.ts',
      }),
    ).toMatchObject({ admitted: true });
    expect(
      admitCandidateEffect({
        receipt: implementerPass,
        role: 'implementer',
        declaredFile: 'src/other.ts',
      }),
    ).toMatchObject({ admitted: false });
    expect(
      admitCandidateEffect({
        receipt: { ...implementerPass, changedFiles: ['src/hello.ts', 'src/extra.ts'] },
        role: 'implementer',
        declaredFile: 'src/hello.ts',
      }),
    ).toMatchObject({ admitted: false });
  });

  it('names the refused backend and its reason on unsupported planner rows', async () => {
    const reasons = {
      aider: /read-only planner contract/i,
      copilot: /non-writing programmatic planner posture/i,
    } as const;
    for (const tool of ['aider', 'copilot'] as const) {
      const config = makeConfig({ planner: { kind: 'cli', tool } });
      const slot = { role: 'planner' } as const;
      const preparationId = `unsupported-${tool}`;
      const gates: readonly RunnerGate[] = [
        { kind: 'cli', slot, preparationId, tool, executable: executableReceipt() },
      ];
      await expect(
        createPlanner(config, {
          preparedConfig: config,
          preparationId,
          gates,
          slot,
          initialSessionId: null,
        }),
      ).rejects.toMatchObject({
        kind: 'task_compiler_capability_unsupported',
        data: { backend: tool, missing: ['backend'] },
        message: expect.stringMatching(reasons[tool]),
      });
    }
  });

  it('resolves a clean planner through the production factory with hostile host state on PATH', async () => {
    const scenario = await effectScenario('effect-matrix-factory-path');
    const hostileHome = createTempDir('effect-matrix-hostile-home');
    const hostileXdg = createTempDir('effect-matrix-hostile-xdg');
    try {
      await seedHostileConfig({ projectDir: scenario.projectDir, hostileHome, hostileXdg });
      vi.stubEnv('HOME', hostileHome);
      vi.stubEnv('XDG_CONFIG_HOME', hostileXdg);
      vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
      const receipt = await fixtureExecutable({ directory: scenario.toolsDir, body: 'exit 0' });
      const authority = plannerAuthority(receipt);
      const config = effectConfig();
      const planner = await createPlanner(config, {
        preparedConfig: config,
        ...authority,
        initialSessionId: null,
      });
      const result = await planner.review('review the staged plan', scenario.projectDir, {
        onOutput: () => {},
      });
      expect(result.text).toBe('');
      expect(await gitStatus(scenario.projectDir)).toEqual([]);
    } finally {
      cleanupTempDir(hostileHome);
      cleanupTempDir(hostileXdg);
      await scenario.cleanup();
    }
  });
});

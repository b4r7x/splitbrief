import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableReceipt } from '../../../src/core/discovery/detection.js';
import type { CliToolId } from '../../../src/core/runners/cli-tool-catalog.js';
import { createPlanner } from '../../../src/engine/runners/factory.js';
import { codexPlannerAdapter } from '../../../src/engine/runners/cli-tools/codex.js';
import { opencodePlannerAdapter } from '../../../src/engine/runners/cli-tools/opencode.js';
import { CLI_CONFORMANCE_EXIT_CODES } from '../../../src/engine/runners/cli-tools/contract-harness.js';
import { runFactoryEffectConformance } from '../../../src/engine/runners/cli-tools/contract-harness-effects.js';
import type { RunnerGate } from '../../../src/engine/runners/prepared-execution.js';
import {
  effectScenario,
  fixtureExecutable,
  gitStatus,
  seedHostileConfig,
} from '#testing/helpers/factories/cli-effect-fixture.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir, normalizeMacTmpPath } from '#testing/helpers/temp-dir.js';

const SENTINEL = 'final-\u03b1\u03b2-\u2713-\ud83d\ude80-matrix-sentinel';
const DRAFT = 'draft bytes before the final group';
const SESSION_ID = '00000000-0000-4000-8000-000000000000';

function plannerAuthority(receipt: CliExecutableReceipt, tool: CliToolId, preparationId: string) {
  const slot = { role: 'planner' } as const;
  const gates: readonly RunnerGate[] = [
    { kind: 'cli', slot, preparationId, tool, executable: receipt },
  ];
  return { slot, preparationId, gates };
}

function textEvent(text: string): string {
  return JSON.stringify({ type: 'text', part: { type: 'text', text } });
}

function toolUseEvent(): string {
  return JSON.stringify({
    type: 'tool_use',
    part: {
      tool: 'read',
      id: 'read_0',
      name: 'read',
      state: { status: 'completed', input: { file: 'x' }, output: 'tool out' },
    },
  });
}

function echoJson(value: string): string {
  return `printf '%s\\n' '${value}'`;
}

describe('runner capability and session matrix — exact tuples, fresh scopes, zero-dispatch refusals', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('mandatory OpenCode row (REQ-047, REQ-017, REQ-049)', () => {
    it('runs the planner through the production factory with the effective plan role and only the final group as content', async () => {
      const scenario = await effectScenario('capability-matrix-mandatory');
      try {
        vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
        const log = join(scenario.toolsDir, 'invocations.log');
        const body = [
          `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
          echoJson(textEvent(DRAFT)),
          echoJson(toolUseEvent()),
          echoJson(textEvent(SENTINEL)),
          'exit 0',
        ].join('\n');
        const receipt = await fixtureExecutable({ directory: scenario.toolsDir, body });
        const config = makeConfig({ planner: { kind: 'cli', tool: 'opencode' } });
        const planner = await createPlanner(config, {
          preparedConfig: config,
          ...plannerAuthority(receipt, 'opencode', 'capability-matrix-planner'),
          initialSessionId: null,
        });

        const result = await planner.review('review the staged plan', scenario.projectDir, {
          onOutput: () => {},
        });

        expect(result.text).toBe(SENTINEL);
        const invocation = readFileSync(log, 'utf8').trim();
        expect(invocation).toContain('--agent plan');
        expect(invocation).toContain('--format json');
        expect(invocation).not.toContain('--resume');
        expect(invocation).not.toContain('--session');
        expect(invocation).not.toContain('--continue');
      } finally {
        await scenario.cleanup();
      }
    });
  });

  describe('fresh, resume, and detached session rows (REQ-005, REQ-017)', () => {
    it('a fresh OpenCode call never resumes even with a supplied initial session id, and consecutive calls are detached processes', async () => {
      const scenario = await effectScenario('capability-matrix-fresh');
      try {
        vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
        const capture = join(scenario.toolsDir, 'spawns.txt');
        const body = [
          `printf '%s\\n' "$$|$*" >> ${JSON.stringify(capture)}`,
          echoJson(textEvent(SENTINEL)),
          'exit 0',
        ].join('\n');
        const receipt = await fixtureExecutable({ directory: scenario.toolsDir, body });
        const config = makeConfig({ planner: { kind: 'cli', tool: 'opencode' } });
        const planner = await createPlanner(config, {
          preparedConfig: config,
          ...plannerAuthority(receipt, 'opencode', 'capability-matrix-fresh'),
          initialSessionId: SESSION_ID,
        });

        await planner.review('review the staged plan first', scenario.projectDir, {
          onOutput: () => {},
        });
        await planner.review('review the staged plan second', scenario.projectDir, {
          onOutput: () => {},
        });

        expect(opencodePlannerAdapter.supportsSessionResume).toBe(false);
        const lines = readFileSync(capture, 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line.length > 0 && !line.endsWith('|--version'));
        expect(lines).toHaveLength(2);
        const first = lines[0]?.split('|') ?? [];
        const second = lines[1]?.split('|') ?? [];
        expect(first[0]).toBeTruthy();
        expect(second[0]).toBeTruthy();
        expect(first[0]).not.toBe(second[0]);
        for (const argv of [first[1] ?? '', second[1] ?? '']) {
          expect(argv).toContain('--agent plan');
          expect(argv).not.toContain('--resume');
          expect(argv).not.toContain('--session');
          expect(argv).not.toContain('--continue');
        }
      } finally {
        await scenario.cleanup();
      }
    });

    it('Codex resume is explicit and read-only; a fresh or detached call never carries a session flag', () => {
      expect(codexPlannerAdapter.supportsSessionResume).toBe(true);
      const resumeArgs = codexPlannerAdapter.buildArgs({
        prompt: 'review the staged plan',
        model: undefined,
        projectDir: '.',
        configuredArgs: [],
        mode: 'plan',
        sessionId: SESSION_ID,
        effort: undefined,
      });
      const resumeVector = resumeArgs.join(' ');
      expect(resumeVector).toContain('--sandbox read-only');
      expect(resumeVector).toContain('--ask-for-approval never');
      expect(resumeVector).toContain('exec resume');
      expect(resumeVector).toContain(SESSION_ID);

      const freshArgs = codexPlannerAdapter.buildArgs({
        prompt: 'review the staged plan',
        model: undefined,
        projectDir: '.',
        configuredArgs: [],
        mode: 'plan',
        sessionId: null,
        effort: undefined,
      });
      const freshVector = freshArgs.join(' ');
      expect(freshVector).not.toContain('resume');
      expect(freshVector).not.toContain('--ephemeral');
      expect(freshVector).toContain('--sandbox read-only');
    });
  });

  describe('authority-bearing configuration rows (REQ-018)', () => {
    it('a configured override of adapter-owned sandbox authority refuses with zero spawns', async () => {
      const scenario = await effectScenario('capability-matrix-config');
      try {
        vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
        const markerPath = join(scenario.toolsDir, 'spawned.marker');
        const receipt = await fixtureExecutable({
          directory: scenario.toolsDir,
          body: `touch ${JSON.stringify(markerPath)}\nexit 0`,
        });
        const config = makeConfig({
          planner: {
            kind: 'cli',
            tool: 'opencode',
            args: ['--sandbox', 'read-write'],
          },
        });
        await expect(
          createPlanner(config, {
            preparedConfig: config,
            ...plannerAuthority(receipt, 'opencode', 'capability-matrix-config'),
            initialSessionId: null,
          }),
        ).rejects.toMatchObject({ kind: 'planner-configured-args-rejected' });
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        await scenario.cleanup();
      }
    });

    it('hostile host and project configuration cannot widen the adapter-owned role vector', async () => {
      const scenario = await effectScenario('capability-matrix-hostile');
      const hostileHome = createTempDir('capability-matrix-hostile-home');
      const hostileXdg = createTempDir('capability-matrix-hostile-xdg');
      try {
        await seedHostileConfig({ projectDir: scenario.projectDir, hostileHome, hostileXdg });
        vi.stubEnv('HOME', hostileHome);
        vi.stubEnv('XDG_CONFIG_HOME', hostileXdg);
        vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
        const log = join(scenario.toolsDir, 'invocations.log');
        const body = [
          `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
          echoJson(textEvent(SENTINEL)),
          'exit 0',
        ].join('\n');
        const receipt = await fixtureExecutable({ directory: scenario.toolsDir, body });
        const config = makeConfig({ planner: { kind: 'cli', tool: 'opencode' } });
        const planner = await createPlanner(config, {
          preparedConfig: config,
          ...plannerAuthority(receipt, 'opencode', 'capability-matrix-hostile'),
          initialSessionId: null,
        });

        const result = await planner.review('review the staged plan', scenario.projectDir, {
          onOutput: () => {},
        });
        expect(result.text).toBe(SENTINEL);

        const invocation = readFileSync(log, 'utf8').trim();
        expect(invocation).toContain('--agent plan');
        expect(invocation).toContain('--format json');
        expect(invocation).not.toContain('--permission-mode');
        expect(invocation).not.toContain('--allowedTools');
        expect(invocation).not.toContain('--mcp-config');
        expect(await gitStatus(scenario.projectDir)).toEqual([]);
      } finally {
        cleanupTempDir(hostileHome);
        cleanupTempDir(hostileXdg);
        await scenario.cleanup();
      }
    });
  });

  describe('containment and runtime rows (REQ-015, REQ-019, REQ-049)', () => {
    it('the planner child is confined to the staged checkout: host roots and sibling worktrees stay untouched', async () => {
      const scenario = await effectScenario('capability-matrix-containment');
      const siblingDir = createTempDir('capability-matrix-sibling');
      try {
        vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
        createTestGitRepo(siblingDir, { 'marker.txt': 'sibling-marker\n' });
        const envMarker = join(scenario.toolsDir, 'env.txt');
        const siblingLeak = join(siblingDir, 'leak.txt');
        const body = [
          `printf '%s' 'host-leak' > "$HOME/host-leak.txt"`,
          `printf '%s' 'sibling-leak' > '${siblingLeak}'`,
          `printf '%s\\n' "$HOME|$TMPDIR|$XDG_CONFIG_HOME|$XDG_CACHE_HOME" > '${envMarker}'`,
          echoJson(textEvent(SENTINEL)),
          'exit 0',
        ].join('\n');
        const outcome = await runFactoryEffectConformance({
          role: 'planner',
          projectDir: scenario.projectDir,
          prompt: 'review the staged plan',
          executable: await fixtureExecutable({ directory: scenario.toolsDir, body }),
          effect: { kind: 'planner-read-only' },
          recordPath: scenario.recordPath,
        });
        expect(outcome).toMatchObject({
          exitCode: CLI_CONFORMANCE_EXIT_CODES.PASS,
          verdict: 'PASS',
          role: 'planner',
        });

        const envLine = readFileSync(envMarker, 'utf8').split('\n')[0] ?? '';
        const [home, tmp, xdgConfig, xdgCache] = envLine.split('|');
        const projectReal = normalizeMacTmpPath(realpathSync(scenario.projectDir)) ?? '';
        for (const value of [home ?? '', xdgConfig ?? '', xdgCache ?? '']) {
          expect(normalizeMacTmpPath(value)?.startsWith(projectReal)).toBe(true);
        }
        expect(normalizeMacTmpPath(tmp ?? '')?.startsWith(projectReal)).toBe(false);
        expect(await readFile(join(siblingDir, 'marker.txt'), 'utf8')).toBe('sibling-marker\n');
        expect(await gitStatus(scenario.projectDir)).toEqual([]);
      } finally {
        cleanupTempDir(siblingDir);
        await scenario.cleanup();
      }
    });

    it('executable drift after receipt issuance fails closed before any spawn', async () => {
      const scenario = await effectScenario('capability-matrix-drift');
      try {
        vi.stubEnv('PATH', `${scenario.toolsDir}${delimiter}${process.env.PATH ?? ''}`);
        const markerPath = join(scenario.toolsDir, 'spawned.marker');
        const receipt = await fixtureExecutable({
          directory: scenario.toolsDir,
          body: `printf spawned > ${markerPath}\nexit 0`,
        });
        await writeFile(join(scenario.toolsDir, 'opencode'), '\n# drifted\n', { flag: 'a' });
        const outcome = await runFactoryEffectConformance({
          role: 'planner',
          projectDir: scenario.projectDir,
          prompt: 'review the staged plan',
          executable: receipt,
          effect: { kind: 'planner-read-only' },
          recordPath: scenario.recordPath,
        });
        expect(outcome.verdict).toBe('OMIT');
        expect(outcome.reason).toMatch(/identity/i);
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        await scenario.cleanup();
      }
    });
  });
});

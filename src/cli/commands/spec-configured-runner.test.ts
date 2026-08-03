import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import {
  CONFIG_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SPLITBRIEF_DIR,
  SPEC_FILE,
  TASKS_FILE,
} from '../../core/paths.js';
import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import type { ArtifactApprovalReview } from '../../engine/runners/types.js';
import {
  promptCustomRunnerArtifactApproval,
  promptCustomRunnerDisclosure,
} from '../custom-runner-prompts.js';
import { registerSpecCommand } from './spec.js';

let tmp: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: boolean | undefined;

function setStdinIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, writable: true, configurable: true });
}

beforeEach(() => {
  tmp = realpathSync(createTempDir('spec-command-test'));
  createTestGitRepo(tmp);
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  originalIsTTY = process.stdin.isTTY;
});

afterEach(() => {
  setStdinIsTTY(originalIsTTY);
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
});

function sessionsRoot(): string {
  return join(tmp, SPLITBRIEF_DIR, 'sessions');
}

function writeConfig(config: Config): void {
  mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE), JSON.stringify(config, null, 2));
}

const configuredPlannerArtifact = `---
id: T001
title: Record configured planner output
action: create
file: src/configured.ts
depends_on: []
---

### Description
Record a result from the configured planner.

### Implementation Steps
1. Write the configured result.

### Tests
- vitest passes

### Constraints
- Keep the result deterministic
`;

function configuredDirectPlannerConfig(markerEnv: string): Config {
  const childProgram = [
    "const fs = require('node:fs');",
    `const markerPath = process.env[${JSON.stringify(markerEnv)}];`,
    "if (typeof markerPath !== 'string') throw new Error('missing standalone marker path');",
    "fs.appendFileSync(markerPath, process.cwd() + '\\n');",
    "fs.mkdirSync('.splitbrief-runner/output', { recursive: true });",
    `fs.writeFileSync('.splitbrief-runner/output/result', ${JSON.stringify(configuredPlannerArtifact)});`,
  ].join('');
  const command = {
    label: 'Standalone configured direct planner',
    contract: 'direct' as const,
    executable: process.execPath,
    argv: ['-e', childProgram],
    outputFormat: 'text' as const,
    idleWarnMs: 300_000,
    idleKillMs: 1_800_000,
    env: [markerEnv],
  };

  return ConfigSchema.parse({
    ...makeConfig({
      planner: {
        kind: 'agent',
        command: command.executable,
        args: command.argv,
        outputFormat: command.outputFormat,
        idleWarnMs: command.idleWarnMs,
        idleKillMs: command.idleKillMs,
        env: command.env,
      },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    }),
    customCommands: { 'standalone-configured-direct': command },
  });
}

describe('spec command', () => {
  it('runs a real configured child after one interactive confirmation and reuses its receipt', async () => {
    const home = createTempDir('spec-command-configured-receipt-home');
    const markerEnv = `R7_STANDALONE_MARKER_${process.pid}`;
    const markerPath = join(home, 'configured-child-calls');
    const trustPath = join(home, SPLITBRIEF_DIR, 'trust', 'custom-runners.json');
    const originalHome = process.env.HOME;
    const originalMarker = process.env[markerEnv];
    const disclosures: string[] = [];
    let disclosureCount = 0;
    const artifactReviews: ArtifactApprovalReview[] = [];

    try {
      setStdinIsTTY(true);
      process.env.HOME = home;
      process.env[markerEnv] = markerPath;
      writeConfig(configuredDirectPlannerConfig(markerEnv));

      const runSpec = async (feature: string) => {
        const program = new Command();
        program.exitOverride();
        registerSpecCommand(program, {
          promptCustomRunnerDisclosure: async ({ request }) => {
            disclosureCount += 1;
            const answers = [CONFIRM_PHRASE, 'I reviewed this configured planner.'];
            return promptCustomRunnerDisclosure({
              request,
              options: {
                prompt: async () => answers.shift() ?? '',
                write: (text) => disclosures.push(text),
              },
            });
          },
          promptCustomRunnerArtifactApproval: async (review) => {
            artifactReviews.push(review);
            return promptCustomRunnerArtifactApproval({
              ...review,
              options: { prompt: async () => 'yes', write: () => {} },
            });
          },
        });
        await program.parseAsync([
          'node',
          'splitbrief',
          'spec',
          '--project',
          tmp,
          '--allow-hooks',
          feature,
        ]);
      };

      await runSpec('write configured planner evidence');
      await runSpec('reuse configured planner receipt');

      expect(disclosureCount).toBe(1);
      expect(existsSync(trustPath)).toBe(true);
      expect(disclosures.join('')).toContain(
        'Exact confirmation stores an owner-only reusable receipt.',
      );
      expect(artifactReviews.length).toBeGreaterThan(1);
      expect(artifactReviews.every((review) => review.text === configuredPlannerArtifact)).toBe(
        true,
      );
      const childDirectories = readFileSync(markerPath, 'utf8').trim().split('\n');
      expect(childDirectories.length).toBeGreaterThan(1);
      for (const childDirectory of childDirectories) {
        expect(childDirectory).not.toBe(tmp);
        expect(existsSync(childDirectory)).toBe(false);
      }

      const sessions = readdirSync(sessionsRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(sessions).toHaveLength(2);
      for (const session of sessions) {
        const sessionPath = join(sessionsRoot(), session);
        expect(readFileSync(join(sessionPath, SPEC_FILE), 'utf8')).toBe(configuredPlannerArtifact);
        expect(readFileSync(join(sessionPath, TASKS_FILE), 'utf8')).toBe(configuredPlannerArtifact);
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalMarker === undefined) delete process.env[markerEnv];
      else process.env[markerEnv] = originalMarker;
      cleanupTempDir(home);
    }
  }, 30_000);

  it('denies a real configured child before it writes canonical standalone artifacts', async () => {
    const home = createTempDir('spec-command-configured-deny-home');
    const markerEnv = `R7_STANDALONE_MARKER_${process.pid}`;
    const markerPath = join(home, 'configured-child-calls');
    const trustPath = join(home, SPLITBRIEF_DIR, 'trust', 'custom-runners.json');
    const originalHome = process.env.HOME;
    const originalMarker = process.env[markerEnv];

    try {
      setStdinIsTTY(true);
      process.env.HOME = home;
      process.env[markerEnv] = markerPath;
      writeConfig(configuredDirectPlannerConfig(markerEnv));
      const program = new Command();
      program.exitOverride();
      registerSpecCommand(program, {
        promptCustomRunnerDisclosure: ({ request }) =>
          promptCustomRunnerDisclosure({
            request,
            options: { prompt: async () => 'decline', write: () => {} },
          }),
        promptCustomRunnerArtifactApproval: async () => {
          throw new Error('a denied configured child must not request artifact approval');
        },
      });

      await expect(
        program.parseAsync([
          'node',
          'splitbrief',
          'spec',
          '--project',
          tmp,
          '--allow-hooks',
          'deny configured planner execution',
        ]),
      ).rejects.toMatchObject({ kind: 'cli-error' });

      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(trustPath)).toBe(false);
      const sessions = readdirSync(sessionsRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(sessions).toHaveLength(1);
      const sessionPath = join(sessionsRoot(), sessions[0] ?? 'missing');
      for (const file of [RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE]) {
        expect(existsSync(join(sessionPath, file))).toBe(false);
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalMarker === undefined) delete process.env[markerEnv];
      else process.env[markerEnv] = originalMarker;
      cleanupTempDir(home);
    }
  });

  it('requires a receipt or explicit grant for a non-TTY configured child', async () => {
    const home = createTempDir('spec-command-configured-headless-home');
    const markerEnv = `R7_STANDALONE_MARKER_${process.pid}`;
    const markerPath = join(home, 'configured-child-calls');
    const trustPath = join(home, SPLITBRIEF_DIR, 'trust', 'custom-runners.json');
    const originalHome = process.env.HOME;
    const originalMarker = process.env[markerEnv];
    let disclosureCount = 0;

    try {
      process.env.HOME = home;
      process.env[markerEnv] = markerPath;
      writeConfig(configuredDirectPlannerConfig(markerEnv));
      const runSpec = async (input: { feature: string; allowRepoRunners?: boolean }) => {
        const program = new Command();
        program.exitOverride();
        registerSpecCommand(program, {
          promptCustomRunnerDisclosure: async ({ request }) => {
            disclosureCount += 1;
            const answers = [CONFIRM_PHRASE, 'I reviewed this configured planner.'];
            return promptCustomRunnerDisclosure({
              request,
              options: { prompt: async () => answers.shift() ?? '', write: () => {} },
            });
          },
          promptCustomRunnerArtifactApproval: (review) =>
            promptCustomRunnerArtifactApproval({
              ...review,
              options: { prompt: async () => 'yes', write: () => {} },
            }),
        });
        await program.parseAsync([
          'node',
          'splitbrief',
          'spec',
          '--project',
          tmp,
          '--allow-hooks',
          ...(input.allowRepoRunners ? ['--allow-repo-runners'] : []),
          input.feature,
        ]);
      };

      setStdinIsTTY(false);
      await expect(runSpec({ feature: 'deny non-TTY configured planner' })).rejects.toMatchObject({
        kind: 'cli-error',
      });
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(trustPath)).toBe(false);
      expect(disclosureCount).toBe(0);

      await runSpec({
        feature: 'grant non-TTY configured planner',
        allowRepoRunners: true,
      });
      const childRunsAfterGrant = readFileSync(markerPath, 'utf8').trim().split('\n').length;
      expect(childRunsAfterGrant).toBeGreaterThan(0);
      expect(existsSync(trustPath)).toBe(false);
      expect(disclosureCount).toBe(0);

      setStdinIsTTY(true);
      await runSpec({ feature: 'create configured planner receipt' });
      expect(disclosureCount).toBe(1);
      expect(existsSync(trustPath)).toBe(true);

      setStdinIsTTY(false);
      await runSpec({ feature: 'reuse configured planner receipt from non-TTY' });
      const childRunsAfterReceipt = readFileSync(markerPath, 'utf8').trim().split('\n').length;
      expect(childRunsAfterReceipt).toBeGreaterThan(childRunsAfterGrant);
      expect(disclosureCount).toBe(1);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalMarker === undefined) delete process.env[markerEnv];
      else process.env[markerEnv] = originalMarker;
      cleanupTempDir(home);
    }
  }, 30_000);
});

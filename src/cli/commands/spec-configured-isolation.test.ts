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
import {
  CONFIG_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SANDBOX_DIR,
  SPLITBRIEF_DIR,
  SPEC_FILE,
  TASKS_FILE,
} from '../../core/paths.js';
import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import { createPlanner } from '../../engine/runners/factory.js';
import { DECLARED_PLANNER_ARTIFACT_PATH } from '../../engine/runners/types.js';
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

describe('spec command', () => {
  it('keeps a mismatched base Codex session out of a real configured direct planner stage', async () => {
    setStdinIsTTY(true);
    const hostHome = createTempDir('spec-command-session-home');
    const evidencePath = join(hostHome, 'configured-child-evidence.json');
    const originalHome = process.env.HOME;
    const originalEvidencePath = process.env.R2_STANDALONE_EVIDENCE;
    const sessionCanary = 'r2-standalone-codex-session-canary';
    const stagedEnvFiles = [
      '.env',
      '.env.local',
      '.envrc',
      'nested/.env',
      'nested/.env.development',
      'nested/deep/.envrc',
    ];

    try {
      mkdirSync(join(hostHome, '.codex'), { recursive: true });
      writeFileSync(
        join(hostHome, '.codex', 'auth.json'),
        JSON.stringify({ token: sessionCanary }),
      );
      for (const file of stagedEnvFiles) {
        mkdirSync(join(tmp, file, '..'), { recursive: true });
        writeFileSync(join(tmp, file), `SECRET=${sessionCanary}\n`);
      }
      process.env.HOME = hostHome;
      process.env.R2_STANDALONE_EVIDENCE = evidencePath;

      const baseConfig = makeConfig({
        planner: { kind: 'cli', tool: 'codex', authChannel: 'session' },
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      });
      writeConfig(baseConfig);

      const childProgram = [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        `const checkedEnvFiles = ${JSON.stringify(stagedEnvFiles)};`,
        `const authPath = path.join(process.cwd(), ${JSON.stringify(SANDBOX_DIR)}, 'home', '.codex', 'auth.json');`,
        'const evidence = {',
        '  cwd: process.cwd(),',
        "  auth: fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf8') : null,",
        '  stagedEnvFiles: checkedEnvFiles.filter((file) => fs.existsSync(path.join(process.cwd(), file))),',
        '};',
        'fs.writeFileSync(process.env.R2_STANDALONE_EVIDENCE, JSON.stringify(evidence));',
        `fs.writeFileSync(${JSON.stringify(DECLARED_PLANNER_ARTIFACT_PATH)}, '# isolated configured planner result\\n');`,
      ].join('');
      const command = {
        label: 'Standalone direct isolation canary',
        contract: 'direct' as const,
        executable: process.execPath,
        argv: ['-e', childProgram],
        outputFormat: 'text' as const,
        idleWarnMs: 300_000,
        idleKillMs: 1_800_000,
        env: ['R2_STANDALONE_EVIDENCE'],
      };
      const selectedConfig = ConfigSchema.parse({
        ...baseConfig,
        planner: {
          kind: 'agent',
          command: command.executable,
          args: command.argv,
          outputFormat: command.outputFormat,
          idleWarnMs: command.idleWarnMs,
          idleKillMs: command.idleKillMs,
          env: command.env,
          model: 'r2-standalone-direct',
        },
        customCommands: { 'r2-standalone-direct': command },
      });

      const program = new Command();
      program.exitOverride();
      registerSpecCommand(program, {
        createPlanner: (_base, initialSessionId, options) =>
          createPlanner(selectedConfig, initialSessionId, options),
        promptCustomRunnerDisclosure: async () => ({
          decision: 'confirm',
          phrase: 'I confirm',
          reason: 'I reviewed the configured runner.',
        }),
        promptCustomRunnerArtifactApproval: async () => ({ approved: false }),
      });

      await expect(
        program.parseAsync([
          'node',
          'splitbrief',
          'spec',
          '--project',
          tmp,
          '--allow-hooks',
          'exercise standalone configured planner isolation',
        ]),
      ).rejects.toMatchObject({ kind: 'cli-error' });

      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
        auth: string | null;
        cwd: string;
        stagedEnvFiles: string[];
      };
      expect(evidence.auth).toBeNull();
      expect(evidence.stagedEnvFiles).toEqual([]);
      expect(evidence.cwd).not.toBe(tmp);
      expect(existsSync(evidence.cwd)).toBe(false);

      const [session, ...rest] = readdirSync(sessionsRoot());
      expect(rest).toHaveLength(0);
      if (!session) throw new Error('expected standalone session after configured child rejection');
      const sessionPath = join(sessionsRoot(), session);
      for (const file of [RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE]) {
        expect(existsSync(join(sessionPath, file))).toBe(false);
      }
      expect(existsSync(join(sessionPath, '.custom-runner-review'))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalEvidencePath === undefined) delete process.env.R2_STANDALONE_EVIDENCE;
      else process.env.R2_STANDALONE_EVIDENCE = originalEvidencePath;
      cleanupTempDir(hostHome);
    }
  });
});

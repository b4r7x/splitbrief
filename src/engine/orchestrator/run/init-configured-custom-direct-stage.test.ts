import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../../core/schemas/config.js';
import { ConfigSchema } from '../../../core/schemas/config.js';
import { SANDBOX_DIR, SPLITBRIEF_DIR } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createStagedProject } from '../approval/staged-project.js';
import { createRetryRuntime } from '../escalation/retry-runtime.js';
import { resolveConfiguredCustomRunner } from '../../runners/configured-custom.js';
import { customRunnerSecurityPosture } from '../../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../../runners/custom-admission.js';
import { parsePreparedConfig, type RunnerGate } from '../../runners/prepared-execution.js';
import { runTaskLoop } from '../task/loop.js';
import { configForProfile } from '../task/routing.js';
import { initializeWorkflow } from './init.js';
import { createRunIsolation } from '../isolation/create.js';
import type { RunIsolation } from '../isolation/types.js';

function makeCopyingIsolation(projectDir: string, sessionId: string): RunIsolation {
  return createRunIsolation({
    projectDir,
    sessionId,
    strategy: 'staged-copy',
    onFallback: () => {},
    onRetained: () => {},
  });
}

type DirectRunnerInput = Readonly<{
  id: string;
  file: string;
  costTier: 'cheap' | 'standard';
  sessionId: string;
}>;

function makeDirectRunner(input: DirectRunnerInput) {
  const script = [
    "const fs = require('node:fs'), path = require('node:path');",
    `fs.appendFileSync(process.env.T028_STAGE_EVIDENCE, JSON.stringify({ id: ${JSON.stringify(input.id)}, cwd: process.cwd(), auth: fs.existsSync(path.join(process.cwd(), ${JSON.stringify(SANDBOX_DIR)}, 'home', '.codex', 'auth.json')), env: fs.existsSync(path.join(process.cwd(), '.env')), session: fs.existsSync(path.join(process.cwd(), ${JSON.stringify(SPLITBRIEF_DIR)}, 'sessions', ${JSON.stringify(input.sessionId)})) }) + '\\n');`,
    "fs.mkdirSync('src', { recursive: true });",
    `fs.writeFileSync(${JSON.stringify(input.file)}, 'export const staged = true;\\n');`,
  ].join('');
  const command = {
    label: input.id,
    contract: 'direct' as const,
    executable: process.execPath,
    argv: ['-e', script],
    outputFormat: 'text' as const,
    idleWarnMs: 300_000,
    idleKillMs: 1_800_000,
    env: ['T028_STAGE_EVIDENCE'],
  };

  return {
    commandKey: `t028-${input.id}`,
    profileKey: input.id,
    command,
    profile: {
      kind: 'agent' as const,
      command: command.executable,
      args: command.argv,
      outputFormat: command.outputFormat,
      idleWarnMs: command.idleWarnMs,
      idleKillMs: command.idleKillMs,
      env: command.env,
      model: input.id,
      costTier: input.costTier,
      capabilities: { writesFiles: 'direct' as const },
    },
  };
}

function directConfig(runners: readonly ReturnType<typeof makeDirectRunner>[]): Config {
  const defaultRunner = runners[0];
  if (defaultRunner === undefined) throw new Error('expected a configured direct runner');

  return ConfigSchema.parse({
    ...makeConfig({
      implementer: { kind: 'cli', tool: 'codex', authChannel: 'session' },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { mode: 'quick' },
      approval: { enabled: false, feedRejectionsToPlanner: true },
    }),
    implementerProfiles: {
      default: defaultRunner.profileKey,
      profiles: Object.fromEntries(runners.map((runner) => [runner.profileKey, runner.profile])),
    },
    customCommands: Object.fromEntries(
      runners.map((runner) => [runner.commandKey, runner.command]),
    ),
  });
}

async function initializeConfiguredDirectWorkflow(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    config: Config;
  }>,
) {
  const config = parsePreparedConfig(input.config);
  const preparationId = `configured-direct-${input.sessionId}`;
  const gates: RunnerGate[] = [makeRunnerGate(config.planner, { role: 'planner' }, preparationId)];
  for (const profile of resolveImplementerProfiles(config).profiles) {
    const runner = resolveConfiguredCustomRunner(configForProfile(config, profile), 'implementer');
    if (runner === null) throw new Error(`Expected configured runner for ${profile.name}.`);
    const admission = await prepareCustomRunnerAdmission({
      projectDir: input.projectDir,
      runner,
      posture: customRunnerSecurityPosture('implementer', runner.command.contract),
      phase: 'implementing',
      interaction: 'headless',
      allowRepoRunners: true,
      authorizationPathEnv: process.env.PATH ?? '',
      authorizationPathExt: process.env.PATHEXT ?? '',
    });
    if (admission.kind !== 'admitted') {
      throw new Error(`Expected configured runner admission for ${profile.name}.`);
    }
    gates.push({
      kind: runner.command.contract === 'output' ? 'shell' : 'agent',
      slot: { role: 'implementer', profile: profile.name },
      preparationId,
      command: { kind: 'configured-custom', invocation: admission.invocation },
    });
  }
  ensureSessionDir(input.projectDir, input.sessionId);
  const active = reactivateExistingSession({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
  });
  const { callbacks } = makeCallbacks();
  return initializeWorkflow({
    opts: {
      prepared: {
        purpose: 'new-workflow',
        config,
        preparationId,
        report: {
          generatedAt: new Date(0).toISOString(),
          projectDir: input.projectDir,
          status: 'ready',
          counts: { ok: gates.length, info: 0, warning: 0, blocker: 0 },
          nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
          sections: [],
          metadata: {},
        },
        gates,
        session: {
          kind: 'existing',
          ref: { projectDir: input.projectDir, sessionId: input.sessionId },
          active,
        },
        runtime: {
          feature: 'exercise direct configured stages',
          allowHooks: true,
          allowRepoRunners: true,
        },
      },
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner(),
      headless: true,
    },
    config,
    sessionId: input.sessionId,
    summaryBase: {
      feature: 'exercise direct configured stages',
      startTime: Date.now(),
      plannerTool: 'test-planner',
      implementerTool: 'configured-direct',
      mode: 'quick',
      projectDir: input.projectDir,
      sessionId: input.sessionId,
    },
    metadata: {
      plannerTool: 'test-planner',
      implementerTool: 'configured-direct',
      mode: 'quick',
    },
    setTrackedState: () => {},
    resumeHolder: { messages: [] },
    isolation: makeCopyingIsolation(input.projectDir, input.sessionId),
  });
}

async function expectNoCodexStageBridge(
  input: Readonly<{
    evidencePath: string;
    expectedId: string;
    projectDir: string;
  }>,
) {
  const rows = (await readFile(input.evidencePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  expect(rows).toContainEqual(
    expect.objectContaining({ id: input.expectedId, auth: false, env: false, session: false }),
  );
  expect(rows.every((row: { cwd: string }) => row.cwd !== input.projectDir)).toBe(true);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('configured direct stage canaries', () => {
  it('keeps a direct main configured stage free of the Codex session bridge', {
    timeout: 60_000,
  }, async () => {
    await withTempDir('t028-direct-main-stage-project', async (projectDir) => {
      await withTempDir('t028-direct-main-stage-home', async (hostHome) => {
        createTestGitRepo(projectDir);
        const sessionId = 't028-direct-main-session';
        const evidencePath = join(hostHome, 'evidence.jsonl');
        const originalHome = process.env.HOME;
        const originalEvidence = process.env.T028_STAGE_EVIDENCE;
        try {
          await mkdir(join(hostHome, '.codex'), { recursive: true });
          await writeFile(join(hostHome, '.codex', 'auth.json'), 't028-codex-session-canary');
          await writeFile(join(projectDir, '.env'), 'SHOULD_NOT_BE_STAGED=true\n');
          process.env.HOME = hostHome;
          process.env.T028_STAGE_EVIDENCE = evidencePath;
          const main = makeDirectRunner({
            id: 'main-direct',
            file: 'src/main-direct.ts',
            costTier: 'cheap',
            sessionId,
          });
          const config = directConfig([main]);
          const init = await initializeConfiguredDirectWorkflow({ projectDir, sessionId, config });

          expect(init.ok).toBe(true);
          if (!init.ok) return;
          expect(
            (
              await runTaskLoop({
                wctx: init.wctx,
                initialState: makeImplState([makeTask({ id: 'T001', file: 'src/main-direct.ts' })]),
                setTrackedState: () => {},
                setCurrentTask: () => {},
              })
            ).status,
          ).toBe('complete');
          await expectNoCodexStageBridge({
            evidencePath,
            expectedId: 'main-direct',
            projectDir,
          });
        } finally {
          restoreEnvironment('HOME', originalHome);
          restoreEnvironment('T028_STAGE_EVIDENCE', originalEvidence);
        }
      });
    });
  });

  it('keeps a direct retry configured stage free of the Codex session bridge', {
    timeout: 60_000,
  }, async () => {
    await withTempDir('t028-direct-retry-stage-project', async (projectDir) => {
      await withTempDir('t028-direct-retry-stage-home', async (hostHome) => {
        createTestGitRepo(projectDir);
        const sessionId = 't028-direct-retry-session';
        const evidencePath = join(hostHome, 'evidence.jsonl');
        const originalHome = process.env.HOME;
        const originalEvidence = process.env.T028_STAGE_EVIDENCE;
        try {
          await mkdir(join(hostHome, '.codex'), { recursive: true });
          await writeFile(join(hostHome, '.codex', 'auth.json'), 't028-codex-session-canary');
          await writeFile(join(projectDir, '.env'), 'SHOULD_NOT_BE_STAGED=true\n');
          process.env.HOME = hostHome;
          process.env.T028_STAGE_EVIDENCE = evidencePath;
          const main = makeDirectRunner({
            id: 'main-direct',
            file: 'src/main-direct.ts',
            costTier: 'cheap',
            sessionId,
          });
          const retry = makeDirectRunner({
            id: 'retry-direct',
            file: 'src/retry-direct.ts',
            costTier: 'standard',
            sessionId,
          });
          const config = directConfig([main, retry]);
          const init = await initializeConfiguredDirectWorkflow({ projectDir, sessionId, config });

          expect(init.ok).toBe(true);
          if (!init.ok) return;
          const retryRuntime = await createRetryRuntime(
            {
              ...init.wctx,
              taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
              dependsOnFiles: [],
            },
            'retry-direct',
          );
          const stage = await createStagedProject(projectDir, retryRuntime.config);
          try {
            expect(
              (
                await retryRuntime.implementer.retry({
                  task: makeTask({ id: 'T002', file: 'src/retry-direct.ts' }),
                  projectDir: stage.projectDir,
                  config: retryRuntime.config,
                  context: init.wctx.context,
                  error: 'retry',
                  attempt: 1,
                  kind: 'local',
                  onOutput: () => {},
                  sandboxEnv: stage.sandboxEnv,
                  fileIgnoreProjectDir: projectDir,
                })
              ).success,
            ).toBe(true);
          } finally {
            stage.cleanup();
          }
          await expectNoCodexStageBridge({
            evidencePath,
            expectedId: 'retry-direct',
            projectDir,
          });
        } finally {
          restoreEnvironment('HOME', originalHome);
          restoreEnvironment('T028_STAGE_EVIDENCE', originalEvidence);
        }
      });
    });
  });
});

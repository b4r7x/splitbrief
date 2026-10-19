import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { writeConfig } from '../core/config/load/io.js';
import type { Config } from '../core/schemas/config.js';
import { saveSummary } from '../core/sessions/io.js';
import { createInitialState } from '../core/state/machine.js';
import { saveState } from '../core/state/persistence.js';
import { recordRunTerms } from '../features/workflow/resume-policy.js';
import { configStore } from '../stores/project/config.js';
import { prepareSessionResume } from './prepare-resume.js';

const FEATURE = 'repo-local runners';

let projectDir = '';
let trustHome = '';
let config: Config;

beforeEach(async () => {
  resetAllStores();
  projectDir = createTempDir('prepare-resume-repo-runners');
  trustHome = createTempDir('prepare-resume-repo-runners-home');
  createTestGitRepo(projectDir, {
    'tools/planner.mjs': 'process.stdout.write("");\n',
    'tools/implementer.mjs': 'process.exit(0);\n',
  });
  config = makeConfig({
    planner: { kind: 'shell', command: 'node', args: ['./tools/planner.mjs'] },
    implementer: {
      kind: 'agent',
      command: 'node',
      args: ['./tools/implementer.mjs'],
      model: 'fixture',
    },
  });
  writeConfig(projectDir, config);
  vi.stubEnv('HOME', trustHome);
  await trustDeclaredRunners({ projectDir, config });
  configStore.__testReset({ config, projectDir });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAllStores();
  cleanupTempDir(projectDir);
  cleanupTempDir(trustHome);
});

function seedOpenRun(sessionId: string) {
  const ref = { projectDir, sessionId };
  const state = { ...createInitialState(FEATURE), phase: 'planning' as const };
  saveSummary(ref, makeSession({ id: sessionId, feature: FEATURE, status: 'open' }));
  saveState(ref, state);
  return { ref, state };
}

it('continues a run this process admitted with the repo-runner grant under that grant', async () => {
  const { ref, state } = seedOpenRun('admitted-with-grant');
  recordRunTerms({
    ...makePreparedExecution({ ...ref, feature: FEATURE, config }),
    runtime: { feature: FEATURE, allowRepoRunners: true, allowHooks: false },
  });

  const outcome = await prepareSessionResume({ ref, state }, new AbortController().signal);

  expect(outcome.kind, JSON.stringify(outcome)).toBe('prepared');
  if (outcome.kind !== 'prepared') return;
  expect(outcome.execution.runtime).toMatchObject({ allowRepoRunners: true, allowHooks: false });
});

it('keeps a run this process did not admit outside the grant another run in the project holds', async () => {
  const { ref, state } = seedOpenRun('opened-from-sessions');
  recordRunTerms({
    ...makePreparedExecution({
      projectDir,
      sessionId: 'admitted-elsewhere',
      feature: FEATURE,
      config,
    }),
    runtime: { feature: FEATURE, allowRepoRunners: true, allowHooks: false },
  });

  const outcome = await prepareSessionResume({ ref, state }, new AbortController().signal);

  expect(outcome.kind).toBe('blocked');
  if (outcome.kind !== 'blocked') return;
  const blockers = outcome.report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === 'blocker');
  expect(blockers.map((check) => check.id)).toEqual([
    'runners.preparation.planner',
    'runners.preparation.implementer.default',
  ]);
  for (const check of blockers) {
    expect(check.details).toEqual(['Configured command is outside the current trust policy.']);
    expect(check.fix).toBe(
      'Use a system-installed command, or continue the run from the command line with `splitbrief continue --allow-repo-runners`.',
    );
  }
});

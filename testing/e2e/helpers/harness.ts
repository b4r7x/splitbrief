import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import YAML from 'yaml';
import { ConfigSchema, type Config } from '../../../src/core/schemas/config.js';
import type { WorkflowMode } from '../../../src/core/schemas/enums.js';
import { getApiProviderDescriptor } from '../../../src/core/providers/api-provider-catalog.js';
import { markHooksConfigTrusted } from '../../../src/core/hooks/trust.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { applyCLIOverrides } from '../../../src/core/config/runtime/overrides/apply.js';
import type { ReadinessReport } from '../../../src/core/readiness/types.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { prepareExecution } from '../../../src/engine/runners/prepare-execution.js';
import { resolveHooksConfig } from '../../../src/engine/hooks/discover.js';
import { releasePreparedSession } from '../../../src/core/sessions/prepare.js';
import { createTestGitRepo } from '../../helpers/git.js';
import { resetAllStores } from '../../helpers/stores.js';
import { cleanupTempDir, createTempDir } from '../../helpers/temp-dir.js';
import { useTrustHome } from '../../helpers/trust-home.js';
import { createCassetteRecorder } from '../../helpers/cassette/recorder.js';
import { createCassetteReplayer, loadCassette } from '../../helpers/cassette/replayer.js';
import { TEST_WORKFLOW_SINKS } from '../../helpers/orchestrator-context.js';

export interface E2eScenario {
  name: string;
  cassetteName: string;
  feature: string;
  mode: WorkflowMode;
  config: Config;
}

export interface E2eContext {
  projectDir: string;
  events: EngineEvent[];
  replayer: ReturnType<typeof createCassetteReplayer> | null;
  recorder: ReturnType<typeof createCassetteRecorder> | null;
}

const CASSETTE_DIR = join(import.meta.dirname, '..', 'cassettes');
const CASSETTE_REPLAY_API_KEY = 'e2e-cassette-replay';
const isRecording = process.env.SPLITBRIEF_E2E_RECORD === '1';

export function setupE2eScenario(scenario: E2eScenario): E2eContext {
  const ctx: E2eContext = {
    projectDir: '',
    events: [],
    replayer: null,
    recorder: null,
  };
  let originalApiKey: string | undefined;
  let trustHome: ReturnType<typeof useTrustHome>;

  beforeEach(() => {
    trustHome = useTrustHome(`e2e-trust-home-${scenario.cassetteName}`);
    resetAllStores();
    ctx.events = [];
    ctx.replayer = null;
    ctx.recorder = null;
    originalApiKey = process.env.SPLITBRIEF_E2E_API_KEY;

    if (!isRecording && originalApiKey === undefined) {
      process.env.SPLITBRIEF_E2E_API_KEY = CASSETTE_REPLAY_API_KEY;
    }

    ctx.projectDir = createTempDir(`e2e-${scenario.cassetteName}`);
    createTestGitRepo(ctx.projectDir);

    const splitbriefDir = join(ctx.projectDir, '.splitbrief');
    mkdirSync(splitbriefDir, { recursive: true });
    writeFileSync(join(splitbriefDir, 'config.yaml'), YAML.stringify(scenario.config), 'utf-8');

    const cassettePath = join(CASSETTE_DIR, `${scenario.cassetteName}.json`);

    if (isRecording) {
      ctx.recorder = createCassetteRecorder(cassettePath, scenario.name);
      ctx.recorder.install();
    } else {
      const cassette = loadCassette(cassettePath);
      ctx.replayer = createCassetteReplayer(cassette);
      ctx.replayer.install();
    }
  });

  afterEach(() => {
    try {
      if (ctx.recorder) ctx.recorder.save();
      if (ctx.replayer) ctx.replayer.assertReplayComplete();
    } finally {
      if (ctx.recorder) ctx.recorder.uninstall();
      if (ctx.replayer) ctx.replayer.uninstall();
      if (ctx.projectDir) cleanupTempDir(ctx.projectDir);
      if (originalApiKey === undefined) {
        delete process.env.SPLITBRIEF_E2E_API_KEY;
      } else {
        process.env.SPLITBRIEF_E2E_API_KEY = originalApiKey;
      }
      ctx.projectDir = '';
      ctx.recorder = null;
      ctx.replayer = null;
      trustHome.restore();
    }
  });

  return ctx;
}

export async function runE2eWorkflow(
  ctx: E2eContext,
  scenario: E2eScenario,
): ReturnType<typeof runWorkflow> {
  const bus = createEventBus();
  const baseConfig = replaySafeConfig(loadAndOverrideConfig(ctx.projectDir, scenario.mode));
  const hooks = await resolveHooksConfig(ctx.projectDir, baseConfig.hooks);
  if (hooks !== undefined) markHooksConfigTrusted(ctx.projectDir, hooks);
  const config = hooks === undefined ? baseConfig : ConfigSchema.parse({ ...baseConfig, hooks });
  const preparation = await prepareExecution({
    projectDir: ctx.projectDir,
    feature: scenario.feature,
    effectiveConfig: config,
    policy: {
      purpose: 'new-workflow',
      interaction: 'headless',
      unverifiedAuth: 'allowed',
      allowRepoRunners: false,
      allowHooks: true,
    },
    signal: new AbortController().signal,
  });
  if (preparation.kind === 'failed') throw preparation.error;
  if (preparation.kind === 'blocked') {
    throw new Error(
      `E2E runner preparation was blocked:\n${blockerLines(preparation.report).join('\n')}`,
    );
  }
  if (preparation.kind !== 'prepared') {
    throw new Error(`E2E runner preparation ended with '${preparation.kind}'.`);
  }
  if (preparation.execution.session.kind === 'new') {
    releasePreparedSession({
      ref: preparation.execution.session.ref,
      ownership: preparation.execution.session.ownership,
    });
  }

  return runWorkflow({
    prepared: preparation.execution,
    headless: true,
    sinks: TEST_WORKFLOW_SINKS,
    eventBus: bus,
    _eventSink: (event) => ctx.events.push(event),
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onQuestionAsked: async () => '',
      onContinuationNeeded: async () => '',
      onComplete: () => undefined,
    },
  });
}

/**
 * A blocked preparation is how cassette drift shows up first: the readiness
 * probe hits an entry the workflow was going to use. Naming the blockers here
 * is the difference between "ended with 'blocked'" and a diagnosis.
 */
function blockerLines(report: ReadinessReport): string[] {
  return report.sections.flatMap((section) =>
    section.checks
      .filter((check) => check.severity === 'blocker')
      .map((check) => `  ${check.id}: ${[check.summary, ...(check.details ?? [])].join(' ')}`),
  );
}

function replayRunner(runner: Config['planner'] | Config['implementer']): unknown {
  if (isRecording || runner.kind !== 'api') return runner;
  const descriptor = getApiProviderDescriptor(runner.provider);
  if (descriptor?.endpointPolicy.kind !== 'fixed-origin') return runner;
  return {
    ...runner,
    apiBase: descriptor.endpointPolicy.baseURL,
    ...(descriptor.credentialPrefix === null
      ? {}
      : { apiKey: `${descriptor.credentialPrefix}e2e-replay` }),
  };
}

function replaySafeConfig(config: Config): Config {
  if (isRecording) return config;
  const profiles = config.implementerProfiles;
  return ConfigSchema.parse({
    ...config,
    planner: replayRunner(config.planner),
    implementer: replayRunner(config.implementer),
    ...(profiles === undefined
      ? {}
      : {
          implementerProfiles: {
            ...profiles,
            profiles: Object.fromEntries(
              Object.entries(profiles.profiles).map(([name, profile]) => [
                name,
                replayRunner(profile),
              ]),
            ),
          },
        }),
  });
}

function loadAndOverrideConfig(projectDir: string, mode: WorkflowMode): Config {
  const { config } = loadConfig(projectDir);
  return applyCLIOverrides(config, { mode, approve: 'none' });
}

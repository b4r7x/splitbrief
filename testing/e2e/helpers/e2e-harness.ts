import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import YAML from 'yaml';
import type { Config } from '../../../src/core/schemas/config.js';
import type { WorkflowMode } from '../../../src/core/schemas/enums.js';
import { loadConfig } from '../../../src/core/config/load/load.js';
import { applyCLIOverrides } from '../../../src/core/config/runtime/overrides.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/run.js';
import { createTestGitRepo } from '../../helpers/git.js';
import { resetAllStores } from '../../helpers/stores.js';
import { cleanupTempDir, createTempDir } from '../../helpers/temp-dir.js';
import { createCassetteRecorder } from '../../helpers/cassette/recorder.js';
import { createCassetteReplayer, loadCassette } from '../../helpers/cassette/replayer.js';

export interface E2eScenario {
  name: string;
  cassetteName: string;
  feature: string;
  mode: WorkflowMode;
  config: Record<string, unknown>;
}

export interface E2eContext {
  projectDir: string;
  events: EngineEvent[];
  replayer: ReturnType<typeof createCassetteReplayer> | null;
  recorder: ReturnType<typeof createCassetteRecorder> | null;
}

const CASSETTE_DIR = join(import.meta.dirname, '..', 'cassettes');
const CASSETTE_REPLAY_API_KEY = 'e2e-cassette-replay';
const isRecording = process.env.DIPTYCH_E2E_RECORD === '1';

export function setupE2eScenario(scenario: E2eScenario): E2eContext {
  const ctx: E2eContext = {
    projectDir: '',
    events: [],
    replayer: null,
    recorder: null,
  };
  let originalApiKey: string | undefined;

  beforeEach(() => {
    resetAllStores();
    ctx.events = [];
    ctx.replayer = null;
    ctx.recorder = null;
    originalApiKey = process.env.DIPTYCH_E2E_API_KEY;

    if (!isRecording && originalApiKey === undefined) {
      process.env.DIPTYCH_E2E_API_KEY = CASSETTE_REPLAY_API_KEY;
    }

    ctx.projectDir = createTempDir(`e2e-${scenario.cassetteName}`);
    createTestGitRepo(ctx.projectDir);

    const diptychDir = join(ctx.projectDir, '.diptych');
    mkdirSync(diptychDir, { recursive: true });
    writeFileSync(
      join(diptychDir, 'config.yaml'),
      YAML.stringify(scenario.config),
      'utf-8',
    );

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
      if (ctx.replayer) ctx.replayer.assertAllEntriesConsumed();
    } finally {
      if (ctx.recorder) ctx.recorder.uninstall();
      if (ctx.replayer) ctx.replayer.uninstall();
      if (ctx.projectDir) cleanupTempDir(ctx.projectDir);
      if (originalApiKey === undefined) {
        delete process.env.DIPTYCH_E2E_API_KEY;
      } else {
        process.env.DIPTYCH_E2E_API_KEY = originalApiKey;
      }
      ctx.projectDir = '';
      ctx.recorder = null;
      ctx.replayer = null;
    }
  });

  return ctx;
}

export async function runE2eWorkflow(
  ctx: E2eContext,
  scenario: E2eScenario,
): ReturnType<typeof runWorkflow> {
  const bus = createEventBus();

  return runWorkflow({
    feature: scenario.feature,
    projectDir: ctx.projectDir,
    config: loadAndOverrideConfig(ctx.projectDir, scenario.mode),
    headless: true,
    sinks: { setAbortHandler: () => undefined, setQueueHandler: () => undefined },
    eventBus: bus,
    _eventSink: (event) => ctx.events.push(event),
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onQuestionAsked: async () => '',
      onBudgetExceeded: async () => true,
      onBudgetPaused: async () => {
        throw new Error('Budget paused unexpectedly in e2e test');
      },
      onContinuationNeeded: async () => '',
      onComplete: () => undefined,
    },
  });
}

function loadAndOverrideConfig(projectDir: string, mode: WorkflowMode): Config {
  const { config } = loadConfig(projectDir);
  return applyCLIOverrides(config, { mode, autoApprove: true });
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createElement } from 'react';
import { App, type AppProps } from '../../../../src/app/root.js';
import { createDefaultConfig } from '../../../../src/core/config/load/io.js';
import { createInitialState, transition } from '../../../../src/core/state/machine.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import type { RunWorkflowOptions } from '../../../../src/engine/orchestrator/run/init.js';
import { renderApp as productionRenderApp } from '../../../../src/cli/render/app.js';
import { configStore } from '../../../../src/stores/project/config.js';
import { routerStore } from '../../../../src/stores/navigation/router.js';
import { terminalSizeStore } from '../../../../src/stores/ui/terminal-size.js';
import { resetAllStores } from '../../../helpers/stores.js';
import {
  isDirectExecution,
  PTY_ACTIVE_REVIEW_MARKER,
  PTY_APPROVED_MARKER,
  PTY_CHILD_PROJECT_ENV,
  PTY_VIEWPORT,
} from './contract.js';

export interface PtyChildResult {
  readonly approved: true;
}

interface PtyChildDependencies {
  readonly renderApp: typeof productionRenderApp;
}

const DEFAULT_DEPENDENCIES: PtyChildDependencies = {
  renderApp: productionRenderApp,
};
const PTY_FEATURE = 'PTY behavior contract';

export function parsePtyChildArgs(argv: readonly string[]): void {
  if (argv.length !== 0) throw new Error('PTY child does not accept arguments');
}

export async function runPtyChild(
  argv: readonly string[],
  dependencies: PtyChildDependencies = DEFAULT_DEPENDENCIES,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PtyChildResult> {
  parsePtyChildArgs(argv);
  const configuredProjectDir = env[PTY_CHILD_PROJECT_ENV];
  if (
    !configuredProjectDir ||
    !isAbsolute(configuredProjectDir) ||
    resolve(configuredProjectDir) !== configuredProjectDir ||
    dirname(configuredProjectDir) === configuredProjectDir
  ) {
    throw new Error('PTY child project path is unavailable or unsafe');
  }
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    resetAllStores();
  };
  process.once('exit', cleanup);
  try {
    mkdirSync(configuredProjectDir);
    const projectDir = configuredProjectDir;
    const reviewPath = join(projectDir, 'supporting-spec.md');
    writeFileSync(
      reviewPath,
      `# ${PTY_ACTIVE_REVIEW_MARKER}\n\nApprove this deterministic contract.\n`,
      'utf8',
    );

    resetAllStores();
    const defaults = createDefaultConfig();
    configStore.__testReset({
      config: {
        ...defaults,
        workflow: {
          ...defaults.workflow,
          persistTranscript: false,
        },
      },
      projectDir,
    });
    terminalSizeStore.__testReset({
      cols: PTY_VIEWPORT.cols,
      rows: PTY_VIEWPORT.rows,
      isSmall: false,
    });
    routerStore.init({
      screen: 'workflow',
      feature: PTY_FEATURE,
      resumeState: reviewingSpecState(),
      readiness: readyReadiness(projectDir),
    });

    let result: { approved: boolean } | undefined;
    const runWorkflow = async (options: RunWorkflowOptions): Promise<never> => {
      publishEvent(options, {
        type: 'workflow_started',
        ts: Date.now(),
        phase: 'reviewing-spec',
        feature: PTY_FEATURE,
      });
      result = await options.callbacks.onApprovalNeeded('spec', reviewPath);
      if (result.approved !== true || Object.keys(result).length !== 1) {
        throw new Error('PTY review did not return exactly approved true');
      }
      process.stdout.write(`${PTY_APPROVED_MARKER}\n`);
      return new Promise<never>(() => {});
    };

    await dependencies.renderApp(createElement<AppProps>(App, { workflowDeps: { runWorkflow } }), {
      fullscreen: true,
      projectDir,
    });
    if (result?.approved !== true) throw new Error('PTY review exited before approval');
    return { approved: true };
  } finally {
    process.off('exit', cleanup);
    cleanup();
  }
}

function reviewingSpecState() {
  const initial = createInitialState(PTY_FEATURE, new Date(0));
  const researching = transition(initial, { type: 'START' });
  const specifying = transition(researching, { type: 'RESEARCH_DONE' });
  return transition(specifying, { type: 'SPEC_DONE' });
}

function readyReadiness(projectDir: string) {
  return {
    generatedAt: new Date(0).toISOString(),
    projectDir,
    status: 'ready' as const,
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue' as const, label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
  };
}

function publishEvent(options: RunWorkflowOptions, event: EngineEvent): void {
  if (!options.tuiSink) throw new Error('PTY child has no production TUI event sink');
  options.tuiSink(event);
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown PTY child failure';
  process.stderr.write(`PTY child failed: ${message}\n`);
  process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  void runPtyChild(process.argv.slice(2)).catch(reportFailure);
}

import type { Config } from '../../core/schemas/config.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import type { Planner, PlannerFactoryOptions } from '../planners/types.js';
import type { Reviewer } from '../reviewers/types.js';
import { assertNever } from '../../utils/type-guards.js';
import { resolveConfiguredCustomRunner } from './configured-custom.js';
import { runnerGateFor, type CliStartGate } from './start-gate.js';
import { installRunCompiler } from './compiler-seam.js';
import {
  admitPlannerBackend,
  assertCliImplementerTool,
  gateExpectation,
  implementerConfigForAuthority,
  requireFactoryAuthority,
  resolveConfiguredCustomGate,
  warnDroppedRunnerFields,
  type RunnerFactoryAuthority,
} from './factory-gates.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';

export type PlannerCreationOptions = PlannerFactoryOptions &
  RunnerFactoryAuthority &
  Readonly<{
    initialSessionId?: string | null | undefined;
    /**
     * The run's project root. The remembered detection evidence a compiler
     * claim reuses is written per project, so a construction that omits it
     * pays for a fresh runtime probe instead of reading another project's
     * record.
     */
    projectDir?: string | undefined;
  }>;
type ReviewerCreationOptions = PlannerFactoryOptions & RunnerFactoryAuthority;
export type ImplementerCreationOptions = ImplementerFactoryOptions &
  RunnerFactoryAuthority &
  Readonly<{ intermediateContextLength?: number | undefined }>;

function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= load());
}

const loadClaudeCodePlanner = lazy(() => import('../planners/claude-code.js'));
const loadCliPlanner = lazy(() => import('../planners/cli.js'));
const loadApiPlanner = lazy(() => import('../planners/api.js'));
const loadShellPlanner = lazy(() => import('../planners/shell.js'));
const loadAgentPlanner = lazy(() => import('../planners/agent.js'));
const loadConfiguredCustomPlanner = lazy(() => import('../planners/command-invoke.js'));
const loadCliImplementer = lazy(() => import('../implementers/cli.js'));
const loadApiImplementer = lazy(() => import('../implementers/api.js'));
const loadShellImplementer = lazy(() => import('../implementers/shell.js'));
const loadAgentImplementer = lazy(() => import('../implementers/agent.js'));
const loadConfiguredCustomImplementer = lazy(() => import('../implementers/command-invoke.js'));

async function loadPlanner(
  config: Config,
  initialSessionId?: string | null,
  options?: PlannerFactoryOptions,
): Promise<Planner> {
  const kind = config.planner.kind;
  switch (kind) {
    case 'cli': {
      if (config.planner.tool === 'claude-code') {
        const mod = await loadClaudeCodePlanner();
        return mod.createClaudeCodePlanner({
          authChannel: config.planner.authChannel,
          trustedCli: options?.trustedCli,
          model: config.planner.model,
          initialSessionId,
          effort: config.planner.effort,
          args: config.planner.args,
          timeout: config.planner.timeout,
          idleWarnMs: config.planner.idleWarnMs,
          idleKillMs: config.planner.idleKillMs,
        });
      }
      const mod = await loadCliPlanner();
      return mod.createCliPlanner({ config, initialSessionId, ...options });
    }
    case 'api': {
      const mod = await loadApiPlanner();
      return mod.createApiPlanner(config);
    }
    case 'shell': {
      const mod = await loadShellPlanner();
      return mod.createShellPlanner(config);
    }
    case 'agent': {
      const mod = await loadAgentPlanner();
      return mod.createAgentPlanner(config);
    }
    default:
      return assertNever(kind);
  }
}

export async function createPlanner(
  config: Config,
  options: PlannerCreationOptions,
): Promise<Planner> {
  const authority = requireFactoryAuthority(config, options, 'planner');
  const configured = resolveConfiguredCustomRunner(config, 'planner');
  let planner: Planner;
  let trustedCli: CliStartGate | undefined;

  if (configured !== null) {
    const { runtime, invocation } = resolveConfiguredCustomGate({
      authority,
      configured,
      customRuntime: options.customRuntime,
      role: 'planner',
    });
    const mod = await loadConfiguredCustomPlanner();
    planner = mod.createConfiguredCustomPlanner(configured, runtime, invocation);
  } else {
    const admission = admitPlannerBackend({ config, authority, seat: 'planner' });
    trustedCli = admission.trustedCli;
    planner = await loadPlanner(config, options.initialSessionId, {
      ...options,
      ...(admission.trustedCli !== undefined && { trustedCli: admission.trustedCli }),
    });
  }

  await installRunCompiler({ planner, config, projectDir: options.projectDir, trustedCli });
  warnDroppedRunnerFields({
    runner: config.planner,
    seat: 'planner',
    supportsEffort: planner.capabilities.supportsEffort,
  });
  return planner;
}

/**
 * The review seat: one read-only call against the reviewer runner, which is the
 * planner when no `reviewer:` block is configured. It loads through the planner
 * backends but never carries the Task Brief compiler — a reviewer compiles
 * nothing.
 */
export async function createReviewer(
  config: Config,
  options: ReviewerCreationOptions,
): Promise<Reviewer> {
  const authority = requireFactoryAuthority(config, options, 'reviewer');
  const runner = resolveReviewerRunner(config).runner;
  const configured = resolveConfiguredCustomRunner(config, 'reviewer');
  let reviewer: Planner;

  if (configured !== null) {
    const { runtime, invocation } = resolveConfiguredCustomGate({
      authority,
      configured,
      customRuntime: options.customRuntime,
      role: 'reviewer',
    });
    const mod = await loadConfiguredCustomPlanner();
    reviewer = mod.createConfiguredCustomPlanner(configured, runtime, invocation);
  } else {
    // `loadPlanner` reads `config.planner` by contract, so the review seat reaches
    // the planner backends as a config whose planner slot holds the reviewer.
    const reviewerConfig: Config = { ...config, planner: runner };
    const admission = admitPlannerBackend({ config: reviewerConfig, authority, seat: 'reviewer' });
    reviewer = await loadPlanner(reviewerConfig, null, {
      ...options,
      ...(admission.trustedCli !== undefined && { trustedCli: admission.trustedCli }),
    });
  }

  warnDroppedRunnerFields({
    runner,
    seat: 'reviewer',
    supportsEffort: reviewer.capabilities.supportsEffort,
  });
  return reviewer;
}

export async function createImplementer(
  config: Config,
  options: ImplementerCreationOptions,
): Promise<Implementer> {
  const authority = requireFactoryAuthority(config, options, 'implementer');
  const effectiveConfig = implementerConfigForAuthority(options);
  const configured = resolveConfiguredCustomRunner(effectiveConfig, 'implementer');
  if (configured !== null) {
    const { runtime, invocation } = resolveConfiguredCustomGate({
      authority,
      configured,
      customRuntime: options.customRuntime,
      role: 'implementer',
    });
    const mod = await loadConfiguredCustomImplementer();
    return mod.createConfiguredCustomImplementer({
      runtime,
      admission: invocation,
      factoryOptions: options,
    });
  }

  const kind = effectiveConfig.implementer.kind;
  if (kind === 'cli') {
    assertCliImplementerTool(effectiveConfig.implementer.tool);
  }
  warnDroppedRunnerFields({ runner: effectiveConfig.implementer, seat: 'implementer' });
  const gate = runnerGateFor(
    authority.gates,
    gateExpectation({
      runner: effectiveConfig.implementer,
      slot: authority.slot,
      preparationId: authority.preparationId,
    }),
  );
  const adapterOptions: ImplementerFactoryOptions = {
    ...options,
    ...(gate.kind === 'cli' && { trustedCli: { tool: gate.tool, executable: gate.executable } }),
  };
  switch (kind) {
    case 'cli': {
      const mod = await loadCliImplementer();
      return mod.createCliImplementer(effectiveConfig.implementer, adapterOptions);
    }
    case 'api': {
      const mod = await loadApiImplementer();
      return mod.createApiImplementer(effectiveConfig, adapterOptions);
    }
    case 'shell': {
      const mod = await loadShellImplementer();
      return mod.createShellImplementer(effectiveConfig, adapterOptions);
    }
    case 'agent': {
      const mod = await loadAgentImplementer();
      return mod.createAgentImplementer(effectiveConfig, adapterOptions);
    }
    default:
      return assertNever(kind);
  }
}

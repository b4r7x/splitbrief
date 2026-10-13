import { createDefaultConfig } from '../config/load/defaults.js';
import { getRunnerModelName, type RunnerConfig } from '../config/accessors/runner-config.js';
import type { CliToolDetection, ProviderDetection } from '../discovery/detection.js';
import { CLI_TOOL_IDS, cliToolSupportsRole } from '../runners/cli-tool-catalog.js';
import type { Config } from '../schemas/config.js';
import { resolveEffectiveConfig } from '../config/runtime/effective-config.js';
import type { CLIOverrides } from '../config/runtime/overrides/schema.js';
import { resolveReviewerRunner } from '../config/accessors/reviewer-runner.js';

export type CrewDetection = Readonly<{
  cliTools: readonly CliToolDetection[];
  providers: readonly (Omit<ProviderDetection, 'provider'> & { provider: string })[];
}>;

export function resolveInitialCrew(input: { persisted: Config; overrides: CLIOverrides }): Config {
  const { persisted, overrides } = input;
  const hasSeatOverride = (role: 'planner' | 'implementer' | 'reviewer') =>
    Object.values(overrides[role] ?? {}).some((value) => value !== undefined) ||
    (role === 'planner' && overrides.plannerEffort !== undefined) ||
    (role === 'reviewer' && overrides.reviewerEffort !== undefined) ||
    (role === 'implementer' && overrides.contextLength !== undefined);
  const invocation = resolveEffectiveConfig({ base: createDefaultConfig(), overrides }).config;
  return {
    ...invocation,
    planner: hasSeatOverride('planner') ? invocation.planner : persisted.planner,
    implementer: hasSeatOverride('implementer') ? invocation.implementer : persisted.implementer,
    ...(hasSeatOverride('reviewer')
      ? { reviewer: resolveReviewerRunner(invocation).runner }
      : persisted.reviewer === undefined
        ? {}
        : { reviewer: persisted.reviewer }),
  };
}

export function selectInitialCrew(input: { detected: Config | null; overrides: CLIOverrides }): {
  persisted: Config;
  effective: Config;
} {
  const { detected, overrides } = input;
  const effective = resolveInitialCrew({ persisted: detected ?? createDefaultConfig(), overrides });
  return { persisted: detected ?? effective, effective };
}

export function detectedSeatReady(runner: RunnerConfig, detection: CrewDetection): boolean {
  switch (runner.kind) {
    case 'cli':
      return detection.cliTools.some(
        (tool) => tool.tool === runner.tool && tool.diagnostic.state === 'ready',
      );
    case 'api': {
      const model = getRunnerModelName(runner);
      return detection.providers.some(
        (provider) =>
          provider.provider === runner.provider &&
          provider.available &&
          provider.models?.some((entry) => entry.id === model),
      );
    }
    case 'shell':
    case 'agent':
      return false;
  }
}

export function selectDefaultCrew(detection: CrewDetection): Config | null {
  const ready = new Set(
    detection.cliTools.filter((tool) => tool.diagnostic.state === 'ready').map((tool) => tool.tool),
  );
  const planOrder = ['claude-code', 'codex', ...CLI_TOOL_IDS] as const;
  const plan = planOrder.find((tool) => ready.has(tool) && cliToolSupportsRole(tool, 'planner'));
  if (plan === undefined) return null;

  const config = createDefaultConfig();
  const local = detection.providers.find(
    (provider) => provider.provider === 'ollama' && provider.available,
  );
  const defaultModel = getRunnerModelName(config.implementer);
  const model = local?.models?.find((entry) => entry.id === defaultModel) ?? local?.models?.[0];
  const buildOrder = ['opencode', 'codex', 'claude-code', ...CLI_TOOL_IDS] as const;
  const build = buildOrder.find(
    (tool) => ready.has(tool) && cliToolSupportsRole(tool, 'implementer'),
  );
  const implementer =
    model !== undefined && config.implementer.kind === 'api'
      ? { ...config.implementer, model: model.id }
      : build === undefined
        ? null
        : { kind: 'cli' as const, tool: build };
  if (implementer === null) return null;
  return {
    ...config,
    planner: { kind: 'cli', tool: plan },
    implementer,
  };
}

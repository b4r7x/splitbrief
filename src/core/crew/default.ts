import { createDefaultConfig } from '../config/load/defaults.js';
import { getRunnerModelName, type RunnerConfig } from '../config/accessors/runner-config.js';
import type { SavedCatalogOf } from '../discovery/catalog-read-merge.js';
import type { CliToolDetection, ProviderDetection } from '../discovery/detection.js';
import { routeAuthState } from '../runners/route-auth.js';
import { seatRouteModel } from '../providers/automatic-model.js';
import { cliToolSupportsRole, LISTED_CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';
import type { Config } from '../schemas/config.js';
import {
  resolveEffectiveConfig,
  type EffectiveConfigResult,
} from '../config/runtime/effective-config.js';
import type { CLIOverrides } from '../config/runtime/overrides/schema.js';
import { readActiveRunner } from '../config/accessors/active-runner.js';

export type CrewDetection = Readonly<{
  cliTools: readonly CliToolDetection[];
  providers: readonly (Omit<ProviderDetection, 'provider'> & { provider: string })[];
  /** Each CLI tool's own model listing, which tells a provider set up in the tool's config. */
  cliCatalog?: SavedCatalogOf | undefined;
}>;

// A context length is the invocation's Prompt budget: it never chooses a seat, and the saved crew never keeps it.
function withoutPromptBudgets(overrides: CLIOverrides): CLIOverrides {
  return {
    ...overrides,
    planner: { ...overrides.planner, contextLength: undefined },
    implementer: { ...overrides.implementer, contextLength: undefined },
    reviewer: { ...overrides.reviewer, contextLength: undefined },
    contextLength: undefined,
  };
}

function promptBudgets(overrides: CLIOverrides): CLIOverrides {
  return {
    planner: { contextLength: overrides.planner?.contextLength },
    implementer: { contextLength: overrides.implementer?.contextLength },
    reviewer: { contextLength: overrides.reviewer?.contextLength },
    contextLength: overrides.contextLength,
  };
}

export function resolveInitialCrew(input: {
  persisted: Config;
  overrides: CLIOverrides;
}): EffectiveConfigResult {
  const { persisted } = input;
  const overrides = withoutPromptBudgets(input.overrides);
  const hasSeatOverride = (role: 'planner' | 'implementer' | 'reviewer') =>
    Object.values(overrides[role] ?? {}).some((value) => value !== undefined) ||
    (role === 'planner' && overrides.plannerEffort !== undefined) ||
    (role === 'reviewer' && overrides.reviewerEffort !== undefined);
  const { config: invocation, warnings } = resolveEffectiveConfig({
    base: createDefaultConfig(),
    overrides,
  });
  return {
    config: {
      ...invocation,
      planner: hasSeatOverride('planner') ? invocation.planner : persisted.planner,
      implementer: hasSeatOverride('implementer') ? invocation.implementer : persisted.implementer,
      ...(hasSeatOverride('reviewer')
        ? { reviewer: readActiveRunner({ config: invocation, role: 'reviewer' }) }
        : persisted.reviewer === undefined
          ? {}
          : { reviewer: persisted.reviewer }),
    },
    warnings,
  };
}

export function selectInitialCrew(input: { detected: Config | null; overrides: CLIOverrides }): {
  persisted: Config;
  effective: Config;
  warnings: EffectiveConfigResult['warnings'];
} {
  const { detected, overrides } = input;
  const { config: crew, warnings } = resolveInitialCrew({
    persisted: detected ?? createDefaultConfig(),
    overrides,
  });
  const effective = resolveEffectiveConfig({
    base: crew,
    overrides: promptBudgets(overrides),
  }).config;
  return { persisted: detected ?? crew, effective, warnings };
}

export function detectedSeatReady(runner: RunnerConfig, detection: CrewDetection): boolean {
  switch (runner.kind) {
    // A tool that stores no credential still calls a route its model list serves, as start admits it:
    // a seat on `auto` or with no model calls the model the tool selects on this host.
    case 'cli':
      return detection.cliTools.some(
        (tool) =>
          tool.tool === runner.tool &&
          (tool.diagnostic.state === 'ready' ||
            (tool.diagnostic.state === 'unauthenticated' &&
              routeAuthState({
                tool: tool.tool,
                model: seatRouteModel(runner.model, runner.tool, tool.selectedModel),
                providerAuth: tool.providerAuth,
                catalog: detection.cliCatalog?.(tool.tool),
              }).kind === 'configured')),
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
  const planOrder = ['claude-code', 'codex', ...LISTED_CLI_TOOL_IDS] as const;
  const plan = planOrder.find((tool) => ready.has(tool) && cliToolSupportsRole(tool, 'planner'));
  if (plan === undefined) return null;

  const buildOrder = ['claude-code', 'codex', 'opencode', ...LISTED_CLI_TOOL_IDS] as const;
  const build = buildOrder.find(
    (tool) => ready.has(tool) && cliToolSupportsRole(tool, 'implementer'),
  );
  if (build === undefined) return null;
  return {
    ...createDefaultConfig(),
    planner: { kind: 'cli', tool: plan },
    implementer: { kind: 'cli', tool: build },
  };
}

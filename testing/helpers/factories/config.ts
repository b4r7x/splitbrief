import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_PROVIDER_CATALOG,
  type ApiOffering,
} from '../../../src/core/providers/api-provider-catalog.js';
import { defaultCliAuthChannel } from '../../../src/core/runners/cli-tool-catalog.js';
import { ConfigSchema, type Config } from '../../../src/core/schemas/config.js';
import type {
  ApiImplementerConfig,
  ImplementerConfig,
  ImplementerProfileConfig,
} from '../../../src/core/schemas/implementer-config.js';
import type { ApiPlannerConfig, PlannerConfig } from '../../../src/core/schemas/planner-config.js';
import type { ProjectContext } from '../../../src/core/state/types.js';

const defaultApiImplementer: ApiImplementerConfig = {
  kind: 'api',
  provider: 'ollama',
  service: 'ollama',
  offering: 'local',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://localhost:11434/v1',
  contextLength: 32768,
  temperature: 0.2,
};

type ApiFixture<T extends { service: string; offering: ApiOffering }> = Omit<
  T,
  'service' | 'offering'
> &
  Partial<Pick<T, 'service' | 'offering'>>;

type PartialUnion<T> = T extends unknown ? Partial<T> : never;
type PlannerFixture = Exclude<PlannerConfig, { kind: 'api' }> | ApiFixture<ApiPlannerConfig>;
type ImplementerFixture =
  | Exclude<ImplementerConfig, { kind: 'api' }>
  | ApiFixture<ApiImplementerConfig>;
type ImplementerProfileFixture =
  | Exclude<ImplementerProfileConfig, { kind: 'api' }>
  | ApiFixture<Extract<ImplementerProfileConfig, { kind: 'api' }>>;
type ImplementerProfilesFixture = Omit<NonNullable<Config['implementerProfiles']>, 'profiles'> & {
  profiles: Record<string, ImplementerProfileFixture>;
};

type ConfigOverrides = Omit<
  Partial<Config>,
  'implementer' | 'implementerProfiles' | 'planner' | 'reviewer' | 'validation' | 'workflow'
> & {
  implementer?: PartialUnion<ImplementerFixture>;
  planner?: PlannerFixture;
  // The reviewer schema is the planner's shape, down to the api identity backfill.
  reviewer?: PlannerFixture;
  validation?: Partial<Config['validation']>;
  workflow?: Partial<Config['workflow']>;
  implementerProfiles?: ImplementerProfilesFixture;
};

type ConfigInput = {
  version: Config['version'];
  planner: unknown;
  implementer: unknown;
  reviewer?: unknown;
  validation: Config['validation'];
  workflow: Config['workflow'];
  sessions?: Config['sessions'];
  escalation?: Config['escalation'];
  codebase?: Config['codebase'];
  hooks?: Config['hooks'];
  approval?: Config['approval'];
  implementerProfiles?: ImplementerProfilesFixture;
};

function apiIdentity(provider: string): { service: string; offering: ApiOffering } {
  const descriptor = Object.values(API_PROVIDER_CATALOG).find(({ id }) => id === provider);
  return {
    service: descriptor?.service ?? provider,
    offering: descriptor?.offering ?? 'payg',
  };
}

function makePlannerConfig(planner?: PlannerFixture): unknown {
  const config = planner ?? {
    kind: 'cli' as const,
    tool: 'claude-code' as const,
    authChannel: defaultCliAuthChannel('claude-code').id,
  };
  if (config.kind !== 'api') return config;
  return { ...apiIdentity(config.provider), ...config };
}

function makeImplementerConfig(overrides?: PartialUnion<ImplementerFixture>): unknown {
  if (overrides?.kind !== undefined && overrides.kind !== 'api') return overrides;
  const provider =
    overrides !== undefined && 'provider' in overrides && overrides.provider !== undefined
      ? overrides.provider
      : defaultApiImplementer.provider;
  return { ...defaultApiImplementer, ...apiIdentity(provider), ...overrides };
}

function makeImplementerProfiles(profiles: ImplementerProfilesFixture): ImplementerProfilesFixture {
  return {
    ...profiles,
    profiles: Object.fromEntries(
      Object.entries(profiles.profiles).map(([name, profile]) => [
        name,
        profile.kind === 'api' ? { ...apiIdentity(profile.provider), ...profile } : profile,
      ]),
    ),
  };
}

export function makeConfig(overrides?: ConfigOverrides): Config {
  const base: ConfigInput = {
    version: 3,
    planner: makePlannerConfig(overrides?.planner),
    implementer: makeImplementerConfig(overrides?.implementer),
    validation: {
      typecheck: true,
      lint: true,
      test: true,
      testCommand: 'npm test',
      ...overrides?.validation,
    },
    workflow: {
      maxRetries: 3,
      mode: 'standard',
      taskReview: 'none',
      ...overrides?.workflow,
      compactionFormat: overrides?.workflow?.compactionFormat ?? 'auto',
    },
  };
  if (overrides?.reviewer !== undefined) base.reviewer = makePlannerConfig(overrides.reviewer);
  if (overrides?.sessions !== undefined) base.sessions = overrides.sessions;
  if (overrides?.escalation !== undefined) base.escalation = overrides.escalation;
  if (overrides?.codebase !== undefined) base.codebase = overrides.codebase;
  if (overrides?.hooks !== undefined) base.hooks = overrides.hooks;
  if (overrides?.approval !== undefined) base.approval = overrides.approval;
  if (overrides?.implementerProfiles !== undefined)
    base.implementerProfiles = makeImplementerProfiles(overrides.implementerProfiles);
  return ConfigSchema.parse(base);
}

export function makeNoValidationConfig(overrides?: Parameters<typeof makeConfig>[0]): Config {
  return makeConfig({
    ...overrides,
    validation: {
      typecheck: false,
      lint: false,
      test: false,
      testCommand: 'noop',
      ...overrides?.validation,
    },
  });
}

export function makeApprovalConfig(
  approval: Partial<NonNullable<Config['approval']>> = {},
): Config {
  return makeConfig({
    approval: {
      enabled: approval.enabled ?? true,
      feedRejectionsToPlanner: approval.feedRejectionsToPlanner ?? true,
      ...(approval.tiers !== undefined && { tiers: approval.tiers }),
      ...(approval.allowedPaths !== undefined && { allowedPaths: approval.allowedPaths }),
    },
  });
}

export const defaultContext: ProjectContext = {
  name: 'test-project',
  dir: join(tmpdir(), `splitbrief-test-${process.pid}`),
};

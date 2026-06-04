import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, type Config } from '../../../src/core/schemas/config.js';
import type {
  ApiImplementerConfig,
  ImplementerConfig,
} from '../../../src/core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../../src/core/schemas/planner-config.js';
import type { ProjectContext } from '../../../src/core/state/types.js';

const defaultApiImplementer: ApiImplementerConfig = {
  kind: 'api',
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://localhost:11434/v1',
  contextLength: 32768,
  temperature: 0.2,
};

type ConfigOverrides = Omit<
  Partial<Config>,
  'implementer' | 'planner' | 'validation' | 'workflow'
> & {
  implementer?: Partial<ImplementerConfig>;
  planner?: PlannerConfig;
  validation?: Partial<Config['validation']>;
  workflow?: Partial<Config['workflow']>;
};

type ConfigInput = {
  version: Config['version'];
  planner: PlannerConfig;
  implementer: Partial<ImplementerConfig>;
  validation: Config['validation'];
  workflow: Config['workflow'];
  theme?: Config['theme'];
  shikiTheme?: Config['shikiTheme'];
  sessions?: Config['sessions'];
  escalation?: Config['escalation'];
  codebase?: Config['codebase'];
  hooks?: Config['hooks'];
  approval?: Config['approval'];
  plannerEstimateReview?: Config['plannerEstimateReview'];
  autoSplitOverflow?: Config['autoSplitOverflow'];
  implementerProfiles?: Config['implementerProfiles'];
};

function makeImplementerConfig(overrides?: Partial<ImplementerConfig>): Partial<ImplementerConfig> {
  if (overrides?.kind !== undefined && overrides.kind !== 'api') {
    return overrides;
  }
  return { ...defaultApiImplementer, ...overrides };
}

export function makeConfig(overrides?: ConfigOverrides): Config {
  const base: ConfigInput = {
    version: 2,
    planner: overrides?.planner ?? { kind: 'cli', tool: 'claude-code' },
    implementer: makeImplementerConfig(overrides?.implementer),
    validation: {
      typecheck: true,
      lint: true,
      test: true,
      testCommand: 'npm test',
      ...overrides?.validation,
    },
    workflow: {
      autoApproveSpec: false,
      autoApprovePlan: false,
      maxRetries: 3,
      commitStrategy: 'none',
      persistTranscript: true,
      mode: 'standard',
      taskReview: 'none',
      ...overrides?.workflow,
      compactionFormat: overrides?.workflow?.compactionFormat ?? 'auto',
    },
  };
  if (overrides?.theme !== undefined) base.theme = overrides.theme;
  if (overrides?.shikiTheme !== undefined) base.shikiTheme = overrides.shikiTheme;
  if (overrides?.sessions !== undefined) base.sessions = overrides.sessions;
  if (overrides?.escalation !== undefined) base.escalation = overrides.escalation;
  if (overrides?.codebase !== undefined) base.codebase = overrides.codebase;
  if (overrides?.hooks !== undefined) base.hooks = overrides.hooks;
  if (overrides?.approval !== undefined) base.approval = overrides.approval;
  if (overrides?.plannerEstimateReview !== undefined)
    base.plannerEstimateReview = overrides.plannerEstimateReview;
  if (overrides?.autoSplitOverflow !== undefined)
    base.autoSplitOverflow = overrides.autoSplitOverflow;
  if (overrides?.implementerProfiles !== undefined)
    base.implementerProfiles = overrides.implementerProfiles;
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

export const defaultContext: ProjectContext = {
  name: 'test-project',
  dir: join(tmpdir(), `diptych-test-${process.pid}`),
  runtime: 'node',
  testCommand: 'npm test',
};

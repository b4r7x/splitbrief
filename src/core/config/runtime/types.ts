import type { ApiOffering } from '../../providers/api-catalog.js';
import type { RunnerKind, OutputFormat, EffortLevel } from '../../schemas/enums.js';
import type { ImplementerConfig } from '../../schemas/runner/implementer.js';
import type { PlannerConfig } from '../../schemas/runner/planner.js';

export interface BuildRunnerOpts {
  kind?: RunnerKind | undefined;
  tool?: string | undefined; // cli: tool id; api: provider name
  model?: string | undefined;
  apiBase?: string | undefined;
  apiKey?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  contextLength?: number | undefined;
  temperature?: number | undefined;
  timeout?: number | undefined;
  customModels?: string[] | undefined;
  effort?: EffortLevel | undefined;
  variant?: string | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  maxToolCalls?: number | undefined;
  capabilities?: PlannerCapabilities | undefined;
  service?: string | undefined;
  offering?: ApiOffering | undefined;
  existing?: PlannerConfig | ImplementerConfig | undefined;
}

export type PlannerCapabilities = Extract<PlannerConfig, { kind: 'shell' }>['capabilities'];

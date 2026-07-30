export type PlannerRunnerConfig =
  | {
      readonly kind: 'cli';
      readonly tool: string;
    }
  | {
      readonly kind: 'api';
      readonly provider: string;
      readonly apiBase: string;
      readonly model: string;
    }
  | {
      readonly kind: 'agent-sdk';
      readonly model: string;
    };

export interface ImplementerRunnerConfig {
  readonly kind: 'api';
  readonly provider: string;
  readonly apiBase: string;
  readonly model: string;
}

export interface PairingConfig {
  readonly planner: PlannerRunnerConfig;
  readonly implementer: ImplementerRunnerConfig;
}

function plannerLines(planner: PlannerRunnerConfig): string[] {
  if (planner.kind === 'cli') {
    return [`  kind: ${planner.kind}`, `  tool: ${planner.tool}`];
  }

  if (planner.kind === 'api') {
    return [
      `  kind: ${planner.kind}`,
      `  provider: ${planner.provider}`,
      `  apiBase: ${planner.apiBase}`,
      `  model: ${planner.model}`,
    ];
  }

  return [`  kind: ${planner.kind}`, `  model: ${planner.model}`];
}

export function serializePairingConfig({ planner, implementer }: PairingConfig): string {
  return [
    'version: 3',
    'planner:',
    ...plannerLines(planner),
    'implementer:',
    `  kind: ${implementer.kind}`,
    `  provider: ${implementer.provider}`,
    `  apiBase: ${implementer.apiBase}`,
    `  model: ${implementer.model}`,
    'validation:',
    '  typecheck: true',
    '  lint: true',
    '  test: true',
    'workflow:',
    '  mode: standard',
    '  approve: default',
    '  maxRetries: 3',
    '  git:',
    '    commitStrategy: none',
    '',
  ].join('\n');
}

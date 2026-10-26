import { formatConfigLoaderDiagnostics } from '../../config/load/io.js';
import type { ConfigLoaderDiagnostic } from '../../config/load/io.js';
import type { ReadinessDiagnosticStateId } from '../../schemas/readiness.js';
import type { ReadinessCheck } from '../types.js';

export interface ConfigReadinessInput {
  state: 'loaded' | 'missing' | 'invalid';
  path: string;
  warnings: readonly ConfigLoaderDiagnostic[];
  error?: string | undefined;
  diagnosticState?: ReadinessDiagnosticStateId | undefined;
}

export function buildConfigChecks(configLoad: ConfigReadinessInput): ReadinessCheck[] {
  if (configLoad.state === 'missing') {
    return [
      {
        id: 'config.missing',
        severity: 'blocker',
        summary: 'No .splitbrief/config.yaml found.',
        fix: 'Run `splitbrief init` to create a config.',
        nextAction: 'run-init',
        metadata: { path: configLoad.path },
      },
    ];
  }

  if (configLoad.state === 'invalid') {
    return [
      {
        id: 'config.invalid',
        severity: 'blocker',
        summary: 'Config could not be loaded.',
        details: configLoad.error ? configLoad.error.split('\n') : undefined,
        fix: 'Fix .splitbrief/config.yaml or run `splitbrief init --reconfigure`.',
        ...(configLoad.diagnosticState !== undefined && {
          diagnosticState: configLoad.diagnosticState,
        }),
        nextAction: 'fix-config',
        metadata: { path: configLoad.path },
      },
    ];
  }

  const checks: ReadinessCheck[] = [
    {
      id: 'config.loaded',
      severity: 'ok',
      summary: 'Config loaded.',
      details: [`Path: ${configLoad.path}`],
      metadata: { path: configLoad.path },
    },
  ];

  for (const summary of formatConfigLoaderDiagnostics(configLoad.warnings)) {
    checks.push({ id: 'config.warning', severity: 'warning', summary });
  }

  return checks;
}

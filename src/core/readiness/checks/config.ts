import { formatConfigLoaderDiagnostics } from '../../config/load/io.js';
import type { EffectiveConfigWarning } from '../../config/runtime/effective-config.js';
import type { ReadinessDiagnosticStateId } from '../../schemas/readiness.js';
import type { ReadinessCheck } from '../types.js';

/** A flag or a config setting that SPLITBRIEF does not apply, as the config section states it. */
export const CONFIG_WARNING_CHECK_ID = 'config.warning';

export interface ConfigReadinessInput {
  state: 'loaded' | 'missing' | 'invalid';
  path: string;
  warnings: readonly EffectiveConfigWarning[];
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

  for (const warning of configLoad.warnings) {
    if (warning.kind !== 'ignored-flag') continue;
    checks.push({
      id: CONFIG_WARNING_CHECK_ID,
      severity: 'warning',
      summary: warning.notice,
      fix: warning.fix,
    });
  }
  const diagnostics = configLoad.warnings.filter((warning) => warning.kind !== 'ignored-flag');
  for (const summary of formatConfigLoaderDiagnostics(diagnostics)) {
    checks.push({ id: CONFIG_WARNING_CHECK_ID, severity: 'warning', summary });
  }

  return checks;
}

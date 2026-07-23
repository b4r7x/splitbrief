import { formatEffectiveConfigWarning } from '../../config/runtime/effective-config.js';
import type { EffectiveConfigWarning } from '../../config/runtime/effective-config.js';
import type { ReadinessCheck } from '../types.js';

export interface ConfigReadinessInput {
  state: 'loaded' | 'missing' | 'invalid';
  path: string;
  warnings: readonly EffectiveConfigWarning[];
  error?: string | undefined;
  migratedInMemory?: boolean | undefined;
}

export function buildConfigChecks(configLoad: ConfigReadinessInput): ReadinessCheck[] {
  if (configLoad.state === 'missing') {
    return [
      {
        id: 'config.missing',
        severity: 'blocker',
        summary: 'No .diptych/config.yaml found.',
        fix: 'Run `diptych init` to create a config.',
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
        details: configLoad.error ? [configLoad.error] : undefined,
        fix: 'Fix .diptych/config.yaml or run `diptych init --reconfigure`.',
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
      metadata: {
        path: configLoad.path,
        migratedInMemory: configLoad.migratedInMemory === true,
      },
    },
  ];

  const displayedWarnings = new Set<string>();
  for (const warning of configLoad.warnings) {
    const message = formatEffectiveConfigWarning(warning);
    if (displayedWarnings.has(message)) continue;
    displayedWarnings.add(message);
    const migration = warning.source === 'loader' && warning.diagnostic.kind === 'config-migration';
    checks.push({
      id: 'config.warning',
      severity: 'warning',
      summary: message,
      fix: migration ? 'Run `diptych init --reconfigure` to write a current config.' : undefined,
      nextAction: migration ? 'fix-config' : undefined,
    });
  }

  return checks;
}

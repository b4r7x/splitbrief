import type { ReadinessCheck } from '../types.js';

export interface ConfigReadinessInput {
  state: 'loaded' | 'missing' | 'invalid';
  path: string;
  warnings: string[];
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

  for (const warning of configLoad.warnings) {
    checks.push({
      id: 'config.warning',
      severity: 'warning',
      summary: warning,
      fix: warning.includes('version 2')
        ? 'Run `diptych init --reconfigure` to write a current config.'
        : undefined,
      nextAction: warning.includes('version 2') ? 'fix-config' : undefined,
    });
  }

  return checks;
}

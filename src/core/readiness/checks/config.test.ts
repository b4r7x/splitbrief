import { describe, expect, it } from 'vitest';
import { formatConfigLoaderDiagnostic } from '../../config/load/io.js';
import type { ConfigLoaderDiagnostic } from '../../config/load/io.js';
import { buildConfigChecks } from './config.js';

describe('buildConfigChecks', () => {
  it('surfaces loader warnings without a next action', () => {
    const checks = buildConfigChecks({
      state: 'loaded',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [
        { kind: 'config-file-permissions' },
        { kind: 'retired-value', notice: 'workflow.mode was retired.' },
      ],
    });

    const permissions = checks.find(
      (check) => check.id === 'config.warning' && check.summary.includes('chmod 600'),
    );
    const retired = checks.find(
      (check) => check.id === 'config.warning' && check.summary.includes('workflow.mode'),
    );

    expect(permissions?.nextAction).toBeUndefined();
    expect(retired?.nextAction).toBeUndefined();
  });

  it('publishes the loader diagnostic state on an invalid config', () => {
    const [check] = buildConfigChecks({
      state: 'invalid',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [],
      error: 'implementer.apiBase: Invalid apiBase: must use http or https',
      diagnosticState: 'endpoint-invalid',
    });

    expect(check?.id).toBe('config.invalid');
    expect(check?.diagnosticState).toBe('endpoint-invalid');
  });

  it('publishes no diagnostic state when the loader reports no known failure family', () => {
    const [check] = buildConfigChecks({
      state: 'invalid',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [],
      error: 'planner.model: Required',
    });

    expect(check?.diagnosticState).toBeUndefined();
  });

  it('shows a repeated loader warning once, without a config rewrite', () => {
    const diagnostic = { kind: 'config-file-permissions' } satisfies ConfigLoaderDiagnostic;
    const message = formatConfigLoaderDiagnostic(diagnostic);

    const checks = buildConfigChecks({
      state: 'loaded',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [diagnostic, diagnostic],
    });
    const warnings = checks.filter((check) => check.id === 'config.warning');
    const [warning] = warnings;

    expect(warnings).toHaveLength(1);
    expect(warning?.summary).toBe(message);
    expect(warning?.nextAction).toBeUndefined();
    expect(warning?.fix).toBeUndefined();
  });
});

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type ProbeOptions = {
  env?: Record<string, string | undefined>;
  argv?: string[];
};

function runSpanExportProbe(options: ProbeOptions = {}): string {
  const env = { ...process.env };
  delete env['OTEL_TRACES_EXPORTER'];
  delete env['DIPTYCH_OTEL_EXPORTER'];

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const script = `
    import { trace } from '@opentelemetry/api';
    import { bootstrapOtel } from './src/cli/otel-bootstrap.ts';

    console.dir = (value) => {
      if (value && typeof value === 'object' && value.name === 'probe-span') {
        process.stdout.write('exported:probe-span');
      }
    };

    bootstrapOtel();
    const span = trace.getTracer('probe').startSpan('probe-span');
    span.end();
  `;

  const argv = options.argv && options.argv.length > 0 ? ['--', ...options.argv] : [];
  return execFileSync(process.execPath, ['--import', 'tsx', '--eval', script, ...argv], {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
  });
}

describe('bootstrapOtel', () => {
  it('does not export spans when no supported exporter is requested', () => {
    expect(runSpanExportProbe()).toBe('');
    expect(runSpanExportProbe({ env: { OTEL_TRACES_EXPORTER: 'otlp' } })).toBe('');
  });

  it('exports spans when console exporter is requested', () => {
    expect(runSpanExportProbe({ env: { OTEL_TRACES_EXPORTER: 'console' } })).toBe('exported:probe-span');
    expect(runSpanExportProbe({ env: { DIPTYCH_OTEL_EXPORTER: 'console' } })).toBe('exported:probe-span');
    expect(runSpanExportProbe({ argv: ['--otel-exporter=console'] })).toBe('exported:probe-span');
    expect(runSpanExportProbe({ argv: ['--otel-exporter', 'console'] })).toBe('exported:probe-span');
  });
});

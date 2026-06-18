import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { flushOtel, isMachineReadableStdout, readOtelExporterFromArgv } from './otel.js';

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
    import { bootstrapOtel } from './src/lib/otel.ts';

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
    expect(runSpanExportProbe({ env: { OTEL_TRACES_EXPORTER: 'console' } })).toBe(
      'exported:probe-span',
    );
    expect(runSpanExportProbe({ env: { DIPTYCH_OTEL_EXPORTER: 'console' } })).toBe(
      'exported:probe-span',
    );
    expect(runSpanExportProbe({ argv: ['--otel-exporter=console'] })).toBe('exported:probe-span');
    expect(runSpanExportProbe({ argv: ['--otel-exporter', 'console'] })).toBe(
      'exported:probe-span',
    );
  });

  it('does not export console spans in machine-readable stdout modes', () => {
    expect(
      runSpanExportProbe({ env: { OTEL_TRACES_EXPORTER: 'console' }, argv: ['start', '--json'] }),
    ).toBe('');
    expect(
      runSpanExportProbe({
        env: { DIPTYCH_OTEL_EXPORTER: 'console' },
        argv: ['start', '--rpc'],
      }),
    ).toBe('');
  });
});

describe('readOtelExporterFromArgv', () => {
  it('reads the exporter from the inline and spaced flag forms', () => {
    expect(readOtelExporterFromArgv(['--otel-exporter=console'])).toBe('console');
    expect(readOtelExporterFromArgv(['--otel-exporter', 'otlp'])).toBe('otlp');
    expect(readOtelExporterFromArgv(['start', 'feature'])).toBeUndefined();
  });
});

describe('isMachineReadableStdout', () => {
  it('detects json and rpc output modes', () => {
    expect(isMachineReadableStdout(['start', '--json'])).toBe(true);
    expect(isMachineReadableStdout(['start', '--rpc'])).toBe(true);
    expect(isMachineReadableStdout(['start'])).toBe(false);
  });
});

describe('flushOtel', () => {
  it('drains spans still buffered in a BatchSpanProcessor before exit', async () => {
    const inMemory = new InMemorySpanExporter();
    const exported: string[] = [];
    const recordingExporter: SpanExporter = {
      export(spans: ReadableSpan[], resultCallback) {
        for (const span of spans) exported.push(span.name);
        inMemory.export(spans, resultCallback);
      },
      shutdown: () => inMemory.shutdown(),
      forceFlush: () => inMemory.forceFlush?.() ?? Promise.resolve(),
    };
    const provider = new BasicTracerProvider({
      spanProcessors: [new BatchSpanProcessor(recordingExporter)],
    });
    trace.setGlobalTracerProvider(provider);

    trace.getTracer('flush-test').startSpan('buffered-span').end();
    expect(exported).toHaveLength(0);

    await flushOtel();

    expect(exported).toContain('buffered-span');
    trace.disable();
  });

  it('is a no-op when the global provider has no flush lifecycle', async () => {
    trace.disable();
    await expect(flushOtel()).resolves.toBeUndefined();
  });
});

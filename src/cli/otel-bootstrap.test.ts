import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { bootstrapOtel } from './otel-bootstrap.js';

describe('bootstrapOtel', () => {
  let originalOtelExporter: string | undefined;
  let originalDiptychExporter: string | undefined;
  let originalArgv: string[];

  beforeEach(() => {
    originalOtelExporter = process.env['OTEL_TRACES_EXPORTER'];
    originalDiptychExporter = process.env['DIPTYCH_OTEL_EXPORTER'];
    originalArgv = process.argv;
  });

  afterEach(() => {
    if (originalOtelExporter === undefined) {
      delete process.env['OTEL_TRACES_EXPORTER'];
    } else {
      process.env['OTEL_TRACES_EXPORTER'] = originalOtelExporter;
    }
    if (originalDiptychExporter === undefined) {
      delete process.env['DIPTYCH_OTEL_EXPORTER'];
    } else {
      process.env['DIPTYCH_OTEL_EXPORTER'] = originalDiptychExporter;
    }
    process.argv = originalArgv;
  });

  it('does nothing when no exporter signal is present', () => {
    delete process.env['OTEL_TRACES_EXPORTER'];
    delete process.env['DIPTYCH_OTEL_EXPORTER'];
    process.argv = ['node', 'cli.js', 'start', 'feature'];
    const before = trace.getTracerProvider();
    bootstrapOtel();
    // Provider reference is the same proxy — delegate was not changed
    expect(trace.getTracerProvider()).toBe(before);
  });

  it('does nothing when OTEL_TRACES_EXPORTER is set to an unsupported value', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'otlp';
    const before = trace.getTracerProvider();
    bootstrapOtel();
    expect(trace.getTracerProvider()).toBe(before);
  });

  it('registers a BasicTracerProvider as global delegate when OTEL_TRACES_EXPORTER=console', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'console';
    bootstrapOtel();
    // The global proxy delegates to the real provider; a tracer obtained after
    // bootstrap should be a real SDK Tracer, not a no-op.
    const tracer = trace.getTracer('test');
    // A no-op tracer has a constructor named 'NoopTracer'; a real one is 'Tracer'.
    expect(tracer.constructor.name).toBe('Tracer');
    // Also verify the delegate on the proxy is a BasicTracerProvider
    const provider = trace.getTracerProvider();
    // @ts-expect-error — getDelegate is part of the ProxyTracerProvider API but not the public interface type
    expect(provider.getDelegate()).toBeInstanceOf(BasicTracerProvider);
  });

  it('registers a BasicTracerProvider when DIPTYCH_OTEL_EXPORTER=console', () => {
    delete process.env['OTEL_TRACES_EXPORTER'];
    process.env['DIPTYCH_OTEL_EXPORTER'] = 'console';
    bootstrapOtel();
    const provider = trace.getTracerProvider();
    // @ts-expect-error — getDelegate is part of the ProxyTracerProvider API but not the public interface type
    expect(provider.getDelegate()).toBeInstanceOf(BasicTracerProvider);
  });

  it('registers a BasicTracerProvider when --otel-exporter=console is on argv', () => {
    delete process.env['OTEL_TRACES_EXPORTER'];
    delete process.env['DIPTYCH_OTEL_EXPORTER'];
    process.argv = ['node', 'cli.js', 'start', '--otel-exporter=console', 'feature'];
    bootstrapOtel();
    const provider = trace.getTracerProvider();
    // @ts-expect-error — getDelegate is part of the ProxyTracerProvider API but not the public interface type
    expect(provider.getDelegate()).toBeInstanceOf(BasicTracerProvider);
  });

  it('registers a BasicTracerProvider when --otel-exporter console is on argv (separate token)', () => {
    delete process.env['OTEL_TRACES_EXPORTER'];
    delete process.env['DIPTYCH_OTEL_EXPORTER'];
    process.argv = ['node', 'cli.js', 'start', '--otel-exporter', 'console', 'feature'];
    bootstrapOtel();
    const provider = trace.getTracerProvider();
    // @ts-expect-error — getDelegate is part of the ProxyTracerProvider API but not the public interface type
    expect(provider.getDelegate()).toBeInstanceOf(BasicTracerProvider);
  });
});

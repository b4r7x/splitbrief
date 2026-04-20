import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';

/**
 * Registers a global TracerProvider when a supported exporter is requested.
 *
 * Activation (any of):
 *   - `OTEL_TRACES_EXPORTER=console` (OTel-standard env var)
 *   - `DIPTYCH_OTEL_EXPORTER=console` (diptych-scoped alias)
 *   - `--otel-exporter=console` / `--otel-exporter console` on argv (parsed here
 *     because commander hasn't run yet — the sink needs the provider registered
 *     before any engine import reaches `@opentelemetry/api`, which must happen
 *     in the same module-resolution context as the CLI (ESM dual-resolution;
 *     see docs/OTEL.md §Design decisions).
 *
 * Supported exporter values: 'console'. Anything else is a no-op (user brings
 * their own provider via `trace.setGlobalTracerProvider(...)` before invoking
 * diptych — see docs/OTEL.md).
 */
export function bootstrapOtel(): void {
  const exporterName = resolveExporter();
  if (exporterName !== 'console') return;
  const exporter = new ConsoleSpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
}

function resolveExporter(): string | undefined {
  const fromEnv = process.env['OTEL_TRACES_EXPORTER'] ?? process.env['DIPTYCH_OTEL_EXPORTER'];
  if (fromEnv) return fromEnv;
  return readExporterFromArgv(process.argv);
}

function readExporterFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--otel-exporter=')) return arg.slice('--otel-exporter='.length);
    if (arg === '--otel-exporter') return argv[i + 1];
  }
  return undefined;
}

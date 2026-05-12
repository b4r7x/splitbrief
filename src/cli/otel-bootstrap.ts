import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';

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

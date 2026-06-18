import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-base';

export function bootstrapOtel(): void {
  const exporterName = resolveOtelExporter();
  if (exporterName !== 'console') return;
  if (isMachineReadableStdout(process.argv)) return;
  const exporter = new ConsoleSpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
}

function resolveOtelExporter(): string | undefined {
  const fromEnv = process.env['OTEL_TRACES_EXPORTER'] ?? process.env['DIPTYCH_OTEL_EXPORTER'];
  if (fromEnv) return fromEnv;
  return readOtelExporterFromArgv(process.argv);
}

export function readOtelExporterFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--otel-exporter=')) return arg.slice('--otel-exporter='.length);
    if (arg === '--otel-exporter') return argv[i + 1];
  }
  return undefined;
}

export function isMachineReadableStdout(argv: readonly string[]): boolean {
  return argv.includes('--json') || argv.includes('--rpc');
}

function readMethod(provider: object, name: string): (() => unknown) | null {
  if (!(name in provider)) return null;
  const candidate: unknown = Reflect.get(provider, name);
  return typeof candidate === 'function' ? candidate.bind(provider) : null;
}

// trace.getTracerProvider() returns a ProxyTracerProvider; the registered SDK provider that owns
// forceFlush/shutdown is reachable through its getDelegate().
function resolveProvider(): object {
  const proxy: object = trace.getTracerProvider();
  const getDelegate = readMethod(proxy, 'getDelegate');
  if (!getDelegate) return proxy;
  const delegate: unknown = getDelegate();
  return delegate && typeof delegate === 'object' ? delegate : proxy;
}

// diptych exits via process.exit() on signal/budget/crash and even on normal shutdown, which
// abandons any spans still buffered in a BatchSpanProcessor. Hosts call this before exit so the
// final batch is flushed. A flush/shutdown failure must never block the exit path.
export async function flushOtel(): Promise<void> {
  const provider = resolveProvider();
  for (const name of ['forceFlush', 'shutdown'] as const) {
    const method = readMethod(provider, name);
    if (!method) continue;
    try {
      await method();
    } catch {
      // a flush/shutdown failure must never block process exit
    }
  }
}

import { pathToFileURL } from 'node:url';
import { PROVIDER_CONFORMANCE_EXIT_CODES } from '../src/engine/providers/conformance.js';
import { runProductionProviderConformance } from '../src/engine/providers/conformance-production.js';
import { runRawProviderConformance } from '../src/engine/providers/conformance-raw.js';
import { parseConformanceArguments } from './conformance-arguments.js';

type ParsedArguments =
  | Readonly<{
      mode: 'raw';
      contractJson: string;
      recordPath: string;
    }>
  | Readonly<{
      mode: 'production';
      modulePath: string;
      recordPath: string;
    }>;

function usageError(message: string): never {
  throw new Error(
    `${message}. Usage: provider-conformance raw --contract-json '<json>' --record <json> | production --module <module.ts> --record <json>`,
  );
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const { mode, options } = parseConformanceArguments(
    args,
    ['--contract-json', '--module', '--record'],
    usageError,
  );
  const recordPath = options['--record'] ?? usageError('--record is required');

  if (mode === 'raw') {
    const contractJson =
      options['--contract-json'] ?? usageError('--contract-json is required for raw mode');
    if (options['--module'] !== undefined) usageError('--module is not accepted in raw mode');
    return { mode, contractJson, recordPath };
  }

  const modulePath = options['--module'] ?? usageError('--module is required for production mode');
  if (options['--contract-json'] !== undefined) {
    usageError('--contract-json is not accepted in production mode');
  }
  return { mode, modulePath, recordPath };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArguments(args);
    const outcome =
      parsed.mode === 'raw'
        ? await runRawProviderConformance({
            contractJson: parsed.contractJson,
            recordPath: parsed.recordPath,
          })
        : await runProductionProviderConformance({
            modulePath: parsed.modulePath,
            recordPath: parsed.recordPath,
          });
    if (outcome.reason !== undefined) process.stderr.write(`${outcome.reason}\n`);
    return outcome.exitCode;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'provider conformance failed'}\n`,
    );
    return PROVIDER_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE;
  }
}

const invokedScript = process.argv[1];
if (invokedScript !== undefined && import.meta.url === pathToFileURL(invokedScript).href) {
  process.exitCode = await main();
}

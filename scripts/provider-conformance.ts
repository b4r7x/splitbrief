import { pathToFileURL } from 'node:url';
import { runProviderConformance } from '../src/engine/providers/conformance.js';

interface ParsedRawArguments {
  readonly mode: 'raw';
  readonly contractJson: string;
  readonly recordPath: string;
}

interface ParsedProductionArguments {
  readonly mode: 'production';
  readonly modulePath: string;
  readonly recordPath: string;
}

type ParsedArguments = ParsedRawArguments | ParsedProductionArguments;

function usageError(message: string): never {
  throw new Error(
    `${message}. Usage: provider-conformance raw --contract-json '<json>' --record <json>`,
  );
}

function readOption(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) usageError(`${name} requires a value`);
  return value;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const [mode, ...options] = args;
  if (mode !== 'raw' && mode !== 'production') usageError('mode must be raw or production');

  let contractJson: string | undefined;
  let modulePath: string | undefined;
  let recordPath: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--contract-json') {
      if (contractJson !== undefined) usageError('--contract-json may appear once');
      contractJson = readOption(options, index, '--contract-json');
      index += 1;
      continue;
    }
    if (option === '--module') {
      if (modulePath !== undefined) usageError('--module may appear once');
      modulePath = readOption(options, index, '--module');
      index += 1;
      continue;
    }
    if (option === '--record') {
      if (recordPath !== undefined) usageError('--record may appear once');
      recordPath = readOption(options, index, '--record');
      index += 1;
      continue;
    }
    usageError(`unsupported option ${option}`);
  }

  if (recordPath === undefined) usageError('--record is required');
  if (mode === 'raw') {
    if (contractJson === undefined) usageError('--contract-json is required for raw mode');
    if (modulePath !== undefined) usageError('--module is not accepted in raw mode');
    return { mode, contractJson, recordPath };
  }
  if (modulePath === undefined) usageError('--module is required for production mode');
  if (contractJson !== undefined) usageError('--contract-json is not accepted in production mode');
  return { mode, modulePath, recordPath };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArguments(args);
    const outcome =
      parsed.mode === 'raw'
        ? await runProviderConformance({
            mode: 'raw',
            contractJson: parsed.contractJson,
            recordPath: parsed.recordPath,
          })
        : await runProviderConformance({
            mode: 'production',
            modulePath: parsed.modulePath,
            recordPath: parsed.recordPath,
          });
    if (outcome.reason !== undefined) process.stderr.write(`${outcome.reason}\n`);
    return outcome.exitCode;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'provider conformance failed'}\n`,
    );
    return 1;
  }
}

const invokedScript = process.argv[1];
if (invokedScript !== undefined && import.meta.url === pathToFileURL(invokedScript).href) {
  process.exitCode = await main();
}

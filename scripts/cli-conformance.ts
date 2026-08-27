import { pathToFileURL } from 'node:url';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  type CliConformanceRole,
} from '../src/engine/runners/cli-tools/contract-harness.js';
import { runProductionCliConformance } from '../src/engine/runners/cli-tools/contract-harness-production.js';
import { runRawCliConformance } from '../src/engine/runners/cli-tools/contract-harness-raw.js';
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
      role: CliConformanceRole;
      recordPath: string;
    }>;

function usageError(message: string): never {
  throw new Error(
    `${message}. Usage: cli-conformance raw --contract-json '<json>' --record <json> | production --module <module.ts> --role <planner|implementer> --record <json>`,
  );
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const { mode, options } = parseConformanceArguments(
    args,
    ['--contract-json', '--module', '--role', '--record'],
    usageError,
  );
  const recordPath = options['--record'] ?? usageError('--record is required');

  if (mode === 'raw') {
    const contractJson =
      options['--contract-json'] ?? usageError('--contract-json is required in raw mode');
    if (options['--module'] !== undefined || options['--role'] !== undefined) {
      usageError('--module and --role are production-only options');
    }
    return { mode, contractJson, recordPath };
  }

  const modulePath = options['--module'] ?? usageError('--module is required in production mode');
  const role = options['--role'] ?? usageError('--role is required in production mode');
  if (role !== 'planner' && role !== 'implementer') {
    usageError('--role must be planner or implementer');
  }
  if (options['--contract-json'] !== undefined) usageError('--contract-json is raw-only');
  return { mode, modulePath, role, recordPath };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArguments(args);
    const outcome =
      parsed.mode === 'raw'
        ? await runRawCliConformance({
            contractJson: parsed.contractJson,
            recordPath: parsed.recordPath,
          })
        : await runProductionCliConformance({
            modulePath: parsed.modulePath,
            role: parsed.role,
            recordPath: parsed.recordPath,
          });
    if (outcome.reason !== undefined) process.stderr.write(`${outcome.reason}\n`);
    return outcome.exitCode;
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : 'CLI conformance failed'}\n`);
    return CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE;
  }
}

const invokedScript = process.argv[1];
if (invokedScript !== undefined && import.meta.url === pathToFileURL(invokedScript).href) {
  process.exitCode = await main();
}

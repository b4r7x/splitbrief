import { pathToFileURL } from 'node:url';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  runCliConformance,
  type CliConformanceRole,
} from '../src/engine/runners/cli-tools/contract-harness.js';

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

function optionValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) usageError(`${name} requires a value`);
  return value;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const [mode, ...options] = args;
  if (mode !== 'raw' && mode !== 'production') usageError('mode must be raw or production');

  let contractJson: string | undefined;
  let modulePath: string | undefined;
  let role: CliConformanceRole | undefined;
  let recordPath: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--contract-json') {
      if (contractJson !== undefined) usageError('--contract-json may appear once');
      contractJson = optionValue(options, index, '--contract-json');
      index += 1;
      continue;
    }
    if (option === '--module') {
      if (modulePath !== undefined) usageError('--module may appear once');
      modulePath = optionValue(options, index, '--module');
      index += 1;
      continue;
    }
    if (option === '--role') {
      if (role !== undefined) usageError('--role may appear once');
      const value = optionValue(options, index, '--role');
      if (value !== 'planner' && value !== 'implementer') {
        usageError('--role must be planner or implementer');
      }
      role = value;
      index += 1;
      continue;
    }
    if (option === '--record') {
      if (recordPath !== undefined) usageError('--record may appear once');
      recordPath = optionValue(options, index, '--record');
      index += 1;
      continue;
    }
    usageError(`unsupported option ${option}`);
  }

  if (recordPath === undefined) usageError('--record is required');
  if (mode === 'raw') {
    if (contractJson === undefined) usageError('--contract-json is required in raw mode');
    if (modulePath !== undefined || role !== undefined) {
      usageError('--module and --role are production-only options');
    }
    return { mode, contractJson, recordPath };
  }
  if (modulePath === undefined) usageError('--module is required in production mode');
  if (role === undefined) usageError('--role is required in production mode');
  if (contractJson !== undefined) usageError('--contract-json is raw-only');
  return { mode, modulePath, role, recordPath };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArguments(args);
    const outcome =
      parsed.mode === 'raw'
        ? await runCliConformance({
            mode: 'raw',
            contractJson: parsed.contractJson,
            recordPath: parsed.recordPath,
          })
        : await runCliConformance({
            mode: 'production',
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

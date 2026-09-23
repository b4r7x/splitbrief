import { pathToFileURL } from 'node:url';
import {
  ImplementerCliToolIdSchema,
  type ImplementerCliToolId,
} from '../src/core/schemas/enums.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  type CliConformanceRole,
} from '../src/engine/runners/cli-tools/contract-harness.js';
import { runCwdCliConformance } from '../src/engine/runners/cli-tools/contract-harness-cwd.js';
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
    }>
  | Readonly<{
      mode: 'cwd';
      tool: ImplementerCliToolId;
      model: string | undefined;
      recordPath: string;
    }>;

function usageError(message: string): never {
  throw new Error(
    `${message}. Usage: cli-conformance raw --contract-json '<json>' --record <json> | production --module <module.ts> --role <planner|implementer> --record <json> | cwd --tool <implementer tool id> [--model <id>] --record <json>`,
  );
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const { mode, options } = parseConformanceArguments(
    args,
    ['raw', 'production', 'cwd'],
    ['--contract-json', '--module', '--role', '--record', '--tool', '--model'],
    usageError,
  );
  const recordPath = options['--record'] ?? usageError('--record is required');

  if (mode === 'cwd') {
    const tool = ImplementerCliToolIdSchema.safeParse(options['--tool']);
    if (!tool.success) usageError('--tool must name an admitted implementer tool');
    if (
      options['--contract-json'] !== undefined ||
      options['--module'] !== undefined ||
      options['--role'] !== undefined
    ) {
      usageError('cwd mode takes only --tool, --model and --record');
    }
    return { mode, tool: tool.data, model: options['--model'], recordPath };
  }
  if (options['--tool'] !== undefined || options['--model'] !== undefined) {
    usageError('--tool and --model are cwd-only');
  }
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
        : parsed.mode === 'production'
          ? await runProductionCliConformance({
              modulePath: parsed.modulePath,
              role: parsed.role,
              recordPath: parsed.recordPath,
            })
          : await runCwdCliConformance({
              tool: parsed.tool,
              model: parsed.model,
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

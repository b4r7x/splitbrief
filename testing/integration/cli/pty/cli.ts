import { sanitizeTerminalDiagnosticText } from '../../../../src/utils/display-text.js';
import { isDirectExecution } from './contract.js';
import { runPtySmoke, type PtySmokeResult, type RunPtySmokeOptions } from './run.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export function parsePtyCliOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunPtySmokeOptions {
  if (argv.length !== 0) throw new Error('PTY smoke does not accept arguments');
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    requirement: env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
  };
}

export async function runPtyCli(
  options: RunPtySmokeOptions,
  run: typeof runPtySmoke = runPtySmoke,
): Promise<string> {
  const result = await run(options);
  return formatResult(result);
}

function formatResult(result: PtySmokeResult): string {
  if (result.status === 'skipped') {
    return `PTY behavior SKIP (${result.category}): ${result.reason}`;
  }
  return 'PTY behavior PASS: active review; editor return; approval; terminal restored; processes reaped';
}

async function main(): Promise<void> {
  const message = await runPtyCli(parsePtyCliOptions(process.argv.slice(2)));
  process.stdout.write(`${message}\n`);
}

function reportFailure(error: unknown): void {
  const message =
    error instanceof Error
      ? sanitizeTerminalDiagnosticText(error.message)
      : 'Unknown PTY behavior failure';
  process.stderr.write(`PTY behavior failed: ${message}\n`);
  process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) void main().catch(reportFailure);

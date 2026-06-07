import type { HookEntry, HookCommandEntry, HookModuleEntry } from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import { spawnWithTimeout } from '../../lib/process/spawn.js';
import { isENOENT, isNodeError, processError } from '../../lib/process/errors.js';
import { substituteEventFields } from './substitute.js';
import type { HookOutcome, HookContext } from './types.js';
import { loadHookModule } from './load-module.js';
import { toErrorMessage } from '../../utils/format-errors.js';

type HookResponse = {
  decision?: 'allow' | 'deny' | 'warn';
  message?: string;
};

export async function runHook(
  entry: HookEntry,
  event: EngineEvent,
  ctx: HookContext,
): Promise<HookOutcome> {
  if (entry.kind === 'module') {
    return runModuleHook(entry, event, ctx);
  }
  return runCommandHook(entry, event, ctx);
}

async function runCommandHook(
  entry: HookCommandEntry,
  event: EngineEvent,
  ctx: HookContext,
): Promise<HookOutcome> {
  const args = entry.args.map((a) => substituteEventFields(a, event));
  const stdin = JSON.stringify({ event, context: ctx });

  try {
    const result = await spawnWithTimeout({
      command: entry.command,
      args,
      cwd: ctx.projectDir,
      timeout: entry.timeout_ms,
      stdinInput: stdin,
      onProgress: () => undefined,
    });

    if (result.timedOut) {
      return failureOutcome(entry, `hook timed out after ${entry.timeout_ms}ms`, result.stderr);
    }

    return interpretHookOutput(entry, result.output, result.code, result.stderr);
  } catch (err) {
    if (isENOENT(err)) {
      return { kind: 'warn', message: `hook command not found: ${entry.command}` };
    }
    if (processError.isExitCode(err)) {
      return interpretHookOutput(
        entry,
        String(err.data.output ?? ''),
        err.data.code,
        String(err.data.stderr ?? ''),
      );
    }
    return { kind: 'crash', message: toErrorMessage(err) };
  }
}

function interpretHookOutput(
  entry: HookCommandEntry,
  output: string,
  code: number | null,
  stderr?: string,
): HookOutcome {
  const parsed = tryParseResponse(output);
  const stderrOpt = stderr?.trim() ? { stderr: stderr } : {};
  if (parsed?.decision === 'deny') {
    return {
      kind: 'deny',
      ...(parsed.message !== undefined && { message: parsed.message }),
      ...stderrOpt,
    };
  }
  if (parsed?.decision === 'warn') {
    return {
      kind: 'warn',
      ...(parsed.message !== undefined && { message: parsed.message }),
      ...stderrOpt,
    };
  }
  if (code === 0) return { kind: 'allow', ...stderrOpt };
  return failureOutcome(entry, `command exited with code ${code}`, stderr);
}

async function runModuleHook(
  entry: HookModuleEntry,
  event: EngineEvent,
  ctx: HookContext,
): Promise<HookOutcome> {
  const loaded = await loadHookModule(entry.path, ctx.projectDir);
  if (!loaded.ok) {
    if (
      isENOENT(loaded.error) ||
      (isNodeError(loaded.error) && loaded.error.code === 'ERR_MODULE_NOT_FOUND')
    ) {
      return { kind: 'warn', message: `hook module not found: ${entry.path}` };
    }
    return failureOutcome(entry, `failed to load module: ${loaded.reason}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve(loaded.fn(event, ctx)),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`hook timed out after ${entry.timeout_ms}ms`)),
          entry.timeout_ms,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    return validateOutcome(result);
  } catch (err) {
    return failureOutcome(entry, toErrorMessage(err));
  }
}

function validateOutcome(result: unknown): HookOutcome {
  if (result !== null && typeof result === 'object' && 'kind' in result) {
    const kind = (result as { kind: unknown }).kind;
    if (kind === 'allow' || kind === 'deny' || kind === 'warn' || kind === 'crash') {
      return result as HookOutcome;
    }
  }
  return { kind: 'warn', message: 'hook returned unrecognized outcome shape' };
}

function tryParseResponse(stdout: string): HookResponse | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === 'object') return parsed as HookResponse;
  } catch {
    // malformed hook stdout → treat as no decision (allow)
  }
  return null;
}

function failureOutcome(
  entry: { on_failure: 'block' | 'warn' | 'ignore' },
  message: string,
  stderr?: string,
): HookOutcome {
  const stderrOpt = stderr?.trim() ? { stderr } : {};
  if (entry.on_failure === 'block') return { kind: 'deny', message, ...stderrOpt };
  if (entry.on_failure === 'ignore') return { kind: 'allow', ...stderrOpt };
  return { kind: 'warn', message, ...stderrOpt };
}

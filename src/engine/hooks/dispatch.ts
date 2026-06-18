import type { HookEntry, HookCommandEntry, HookModuleEntry } from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import { spawnWithTimeout } from '../../lib/process/spawn.js';
import { isENOENT, isNodeError, processError } from '../../lib/process/errors.js';
import { startsWithEventPlaceholder, substituteEventFields } from './substitute.js';
import type { HookOutcome, HookContext } from './types.js';
import { loadHookModule } from './load-module.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { error } from '../../utils/error.js';
import { protectConsumerPayload } from '../calls/consumer-policy.js';

type HookResponse = {
  decision?: string;
  message?: string;
};

export const hookError = {
  timedOut: (timeoutMs: number) =>
    error('hook-timed-out', `hook timed out after ${timeoutMs}ms`, { timeoutMs }),
} as const;

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
  const args = guardInterpolatedArgs(entry.args, event);
  const stdin = JSON.stringify(
    protectConsumerPayload({ context: 'hooks', payload: { event, context: ctx } }).payload,
  );

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

function guardInterpolatedArgs(templates: readonly string[], event: EngineEvent): string[] {
  const out: string[] = [];
  let guarded = false;
  for (const template of templates) {
    const value = substituteEventFields(template, event);
    if (!guarded && startsWithEventPlaceholder(template) && value.startsWith('-')) {
      out.push('--');
      guarded = true;
    }
    out.push(value);
  }
  return out;
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
  if (parsed?.decision !== undefined && parsed.decision !== 'allow') {
    return {
      kind: 'warn',
      message: `unrecognized hook decision: ${String(parsed.decision)}`,
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
        timer = setTimeout(() => rej(hookError.timedOut(entry.timeout_ms)), entry.timeout_ms);
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
  const whole = parseJsonObject(trimmed);
  if (whole) return whole;
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = parseJsonObject(lines[i]?.trim() ?? '');
    if (candidate) return candidate;
  }
  return null;
}

function parseJsonObject(text: string): HookResponse | null {
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object') return parsed as HookResponse;
  } catch {
    return null;
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

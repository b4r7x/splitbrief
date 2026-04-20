import type { HookEntry, HookCommandEntry, HookModuleEntry } from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import { spawnWithTimeout } from '../../lib/process/spawn.js';
import { isENOENT } from '../../lib/process/errors.js';
import { substituteEventFields } from './substitute.js';
import type { HookOutcome, HookContext } from './types.js';
import { loadHookModule } from './load-module.js';

interface HookResponse {
  decision?: 'allow' | 'deny' | 'warn';
  message?: string;
}

export async function runHook(entry: HookEntry, event: EngineEvent, ctx: HookContext): Promise<HookOutcome> {
  if (entry.kind === 'module') {
    return runModuleHook(entry, event, ctx);
  }
  return runCommandHook(entry, event, ctx);
}

async function runCommandHook(entry: HookCommandEntry, event: EngineEvent, ctx: HookContext): Promise<HookOutcome> {
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
      return failureOutcome(entry, `hook timed out after ${entry.timeout_ms}ms`);
    }

    const parsed = tryParseResponse(result.output);
    if (parsed?.decision === 'deny') {
      return { kind: 'deny', ...(parsed.message !== undefined && { message: parsed.message }) };
    }
    if (parsed?.decision === 'warn') {
      return { kind: 'warn', ...(parsed.message !== undefined && { message: parsed.message }) };
    }

    if (result.code === 0) return { kind: 'allow' };
    return failureOutcome(entry, `command exited with code ${result.code}`);
  } catch (err) {
    if (isENOENT(err)) {
      return { kind: 'warn', message: `hook command not found: ${entry.command}` };
    }
    return { kind: 'crash', message: err instanceof Error ? err.message : String(err) };
  }
}

async function runModuleHook(entry: HookModuleEntry, event: EngineEvent, ctx: HookContext): Promise<HookOutcome> {
  const loaded = await loadHookModule(entry.path, ctx.projectDir);
  if (!loaded.ok) {
    const reason = loaded.reason.toLowerCase();
    if (reason.includes('cannot find') || reason.includes('no such file') || reason.includes('enoent') || reason.includes('module not found')) {
      return { kind: 'warn', message: `hook module not found: ${entry.path}` };
    }
    return failureOutcome(entry, `failed to load module: ${loaded.reason}`);
  }
  try {
    const result = await Promise.race([
      Promise.resolve(loaded.fn(event, ctx)),
      new Promise<HookOutcome>((_, rej) =>
        setTimeout(() => rej(new Error(`hook timed out after ${entry.timeout_ms}ms`)), entry.timeout_ms),
      ),
    ]);
    return validateOutcome(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timed out')) {
      return failureOutcome(entry, message);
    }
    return { kind: 'crash', message };
  }
}

function validateOutcome(result: unknown): HookOutcome {
  if (result !== null && typeof result === 'object' && 'kind' in result) {
    const kind = (result as { kind: unknown }).kind;
    if (kind === 'allow' || kind === 'deny' || kind === 'warn' || kind === 'crash') {
      return result as HookOutcome;
    }
  }
  return { kind: 'allow' };
}

function tryParseResponse(stdout: string): HookResponse | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === 'object') return parsed as HookResponse;
  } catch {
    // ignore parse failures — hooks with malformed JSON stdout are treated as no-op
  }
  return null;
}

function failureOutcome(entry: { on_failure: 'block' | 'warn' | 'ignore' }, message: string): HookOutcome {
  if (entry.on_failure === 'block') return { kind: 'deny', message };
  if (entry.on_failure === 'ignore') return { kind: 'allow' };
  return { kind: 'warn', message };
}

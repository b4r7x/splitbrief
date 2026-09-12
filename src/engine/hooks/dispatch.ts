import {
  HookCommandResponseSchema,
  type HookEntry,
  type HookCommandEntry,
  type HooksConfig,
  type HookCommandResponse,
} from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import { spawnWithTimeout } from '../../lib/process/spawn/progress.js';
import { isENOENT, processError } from '../../lib/process/errors.js';
import { startsWithEventPlaceholder, substituteEventFields } from './substitute.js';
import type { HookOutcome, HookContext } from './types.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { boundConsumerPayload } from '../../core/payload-bounds.js';
import { isRecord } from '../../utils/type-guards.js';
import { isHooksConfigTrusted } from '../../core/hooks/trust.js';

export async function runTrustedHook(
  entry: HookEntry,
  event: EngineEvent,
  ctx: HookContext,
  hooks: HooksConfig,
): Promise<HookOutcome> {
  const refusal = hookTrustRefusal(ctx.projectDir, hooks);
  if (refusal) return { kind: 'deny', message: refusal };
  return runHook(entry, event, ctx);
}

export function hookTrustRefusal(projectDir: string, hooks: HooksConfig): string | null {
  if (isHooksConfigTrusted(projectDir, hooks)) return null;
  return 'hook configuration or hook files changed after trust; re-run with --allow-hooks or approve hooks again';
}

export async function runHook(
  entry: HookCommandEntry,
  event: EngineEvent,
  ctx: HookContext,
): Promise<HookOutcome> {
  const args = guardInterpolatedArgs(entry.args, event);
  const stdin = JSON.stringify(
    boundConsumerPayload({ context: 'hooks', payload: { event, context: ctx } }).payload,
  );

  try {
    const result = await spawnWithTimeout({
      command: entry.command,
      args,
      cwd: ctx.projectDir,
      timeout: entry.timeout_ms,
      stdinInput: stdin,
      onProgress: () => undefined,
      // Short-lived hook commands skip the runner-pid ledger: the per-spawn
      // sync `ps` exec and jsonl rewrite buy no crash-recovery benefit here.
      ledger: false,
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
  if (parsed.kind === 'invalid') {
    return failureOutcome(entry, parsed.message, stderr);
  }
  if (parsed.kind === 'none') {
    if (code === 0) return { kind: 'allow', ...stderrOpt };
    return failureOutcome(entry, `command exited with code ${code}`, stderr);
  }
  const response = parsed.response;
  if (response.decision === 'deny') {
    return {
      kind: 'deny',
      ...(response.message !== undefined && { message: response.message }),
      ...stderrOpt,
    };
  }
  if (response.decision === 'warn') {
    return {
      kind: 'warn',
      ...(response.message !== undefined && { message: response.message }),
      ...stderrOpt,
    };
  }
  if (code === 0) return { kind: 'allow', ...stderrOpt };
  return failureOutcome(entry, `command exited with code ${code}`, stderr);
}

type ParsedHookResponse =
  | { kind: 'none' }
  | { kind: 'valid'; response: HookCommandResponse }
  | { kind: 'invalid'; message: string };

function tryParseResponse(stdout: string): ParsedHookResponse {
  const trimmed = stdout.trim();
  if (!trimmed) return { kind: 'none' };
  const whole = parseJsonObject(trimmed);
  if (whole) return whole;
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = parseJsonObject(lines[i]?.trim() ?? '');
    if (candidate) return candidate;
  }
  return { kind: 'none' };
}

function parseJsonObject(text: string): ParsedHookResponse | null {
  if (!text.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parseHookResponseObject(parsed);
  } catch {
    return invalidHookResponse();
  }
  return null;
}

function parseHookResponseObject(value: Record<string, unknown>) {
  const parsed = HookCommandResponseSchema.safeParse(value);
  if (parsed.success) return { kind: 'valid' as const, response: parsed.data };
  return invalidHookResponse();
}

function invalidHookResponse(): ParsedHookResponse {
  return {
    kind: 'invalid',
    message:
      'malformed hook response; expected { decision?: "allow" | "deny" | "warn", message?: string }',
  };
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

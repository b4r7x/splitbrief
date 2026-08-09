import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../../../core/schemas/session-log.js';
import type { TokenUsage } from '../../../core/schemas/tokens.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { parseJsonlLine } from '../../../lib/fs.js';
import { RunnerCallRoleSchema } from '../../calls/schema.js';
import type { RunnerCallContext, RunnerCallUsage } from '../../calls/types.js';
import { applyRunnerCallUsageSample, normalizeRunnerCallUsageSample } from '../../calls/usage.js';
import { addRunnerCallUsageToTokenUsage } from '../tokens.js';

type RunnerCallRole = RunnerCallContext['role'];

// The workflow ledger (state.tokenUsage) is credited only on the success path of each
// phase flow, so a run that fails after a call completed loses that call's tokens.
// The session log keeps every runner_call usage record, so the summary reconciles the
// ledger against it: per field, the larger of booked and observed wins — observed tops
// up bookings a failure discarded, and bookings without log records are never reduced.
export function reconcileTokenUsageWithSessionLog(ref: SessionRef, booked: TokenUsage): TokenUsage {
  const observed = observedTokenUsageFromSessionLog(ref);
  if (observed === null) return booked;

  const plannerCacheRead = maxOptional(booked.plannerCacheRead, observed.plannerCacheRead);
  const plannerCacheCreate = maxOptional(booked.plannerCacheCreate, observed.plannerCacheCreate);
  const implementerCacheRead = maxOptional(
    booked.implementerCacheRead,
    observed.implementerCacheRead,
  );
  const implementerCacheCreate = maxOptional(
    booked.implementerCacheCreate,
    observed.implementerCacheCreate,
  );

  return {
    plannerInput: Math.max(booked.plannerInput, observed.plannerInput),
    plannerOutput: Math.max(booked.plannerOutput, observed.plannerOutput),
    implementerInput: Math.max(booked.implementerInput, observed.implementerInput),
    implementerOutput: Math.max(booked.implementerOutput, observed.implementerOutput),
    escalationInput: Math.max(booked.escalationInput, observed.escalationInput),
    escalationOutput: Math.max(booked.escalationOutput, observed.escalationOutput),
    ...(plannerCacheRead !== undefined && { plannerCacheRead }),
    ...(plannerCacheCreate !== undefined && { plannerCacheCreate }),
    ...(implementerCacheRead !== undefined && { implementerCacheRead }),
    ...(implementerCacheCreate !== undefined && { implementerCacheCreate }),
  };
}

const UsageLogEntrySchema = z.looseObject({
  kind: z.literal('event'),
  type: z.enum(['runner_call_usage', 'runner_call_completed', 'runner_call_error']),
  data: z.looseObject({
    callId: z.string().min(1),
    role: RunnerCallRoleSchema,
    usage: z.unknown().optional(),
    semantics: z.unknown().optional(),
  }),
});

type CallUsageFold = {
  role: RunnerCallRole;
  usage: RunnerCallUsage | null;
  terminal: boolean;
};

function observedTokenUsageFromSessionLog(ref: SessionRef): TokenUsage | null {
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE);
  if (!existsSync(filePath)) return null;

  const calls = new Map<string, CallUsageFold>();
  try {
    // The summary path is synchronous, so it cannot consume the canonical async
    // reader in core/sessions/log-reader.ts; it carries that reader's two guards
    // instead — a symlinked log is refused, an oversized entry is skipped.
    if (lstatSync(filePath).isSymbolicLink()) return null;
    forEachLineInFile(filePath, (line) => {
      if (!line.includes('"runner_call_')) return;
      if (Buffer.byteLength(line, 'utf8') > SESSION_LOG_MAX_ENTRY_BYTES) return;
      const parsedLine = parseJsonlLine(line);
      if (parsedLine.kind !== 'value') return;
      const entry = UsageLogEntrySchema.safeParse(parsedLine.value);
      if (!entry.success) return;

      const { callId, role } = entry.data.data;
      let call = calls.get(callId);
      if (call === undefined) {
        call = { role, usage: null, terminal: false };
        calls.set(callId, call);
      }
      // Mirror the collector: samples after a terminal record are ignored, and a
      // terminal record's usage (when present) applies as final.
      if (call.terminal) return;
      const isTerminal = entry.data.type !== 'runner_call_usage';
      if (isTerminal) call.terminal = true;
      const sample = normalizeRunnerCallUsageSample({
        raw: entry.data.data.usage,
        semantics: isTerminal ? 'final' : entry.data.data.semantics,
      });
      if (sample !== null) call.usage = applyRunnerCallUsageSample(call.usage, sample);
    });
  } catch {
    // Best-effort: an invalid session id or unreadable log never blocks the summary.
    return null;
  }
  if (calls.size === 0) return null;

  const observed: TokenUsage = {
    plannerInput: 0,
    plannerOutput: 0,
    implementerInput: 0,
    implementerOutput: 0,
    escalationInput: 0,
    escalationOutput: 0,
  };
  for (const call of calls.values()) {
    if (call.usage !== null) addRunnerCallUsageToTokenUsage(observed, call.role, call.usage);
  }
  return observed;
}

function forEachLineInFile(filePath: string, onLine: (line: string) => void): void {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let leftover = '';
  try {
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      const chunk = leftover + buffer.toString('utf8', 0, bytesRead);
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk.charCodeAt(i) === 10) {
          onLine(chunk.slice(start, i));
          start = i + 1;
        }
      }
      leftover = chunk.slice(start);
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
    if (leftover.length > 0) onLine(leftover);
  } finally {
    closeSync(fd);
  }
}

function maxOptional(booked: number | undefined, observed: number | undefined): number | undefined {
  if (booked === undefined && observed === undefined) return undefined;
  return Math.max(booked ?? 0, observed ?? 0);
}

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { PhaseSchema, type Phase } from '../../../core/schemas/enums.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../../../core/schemas/session-log.js';
import { ZERO_TOKEN_USAGE, type TokenUsage } from '../../../core/schemas/tokens.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { forEachLineSync, parseJsonlLine } from '../../../lib/fs.js';
import { isReviewSeatCall } from '../../calls/review-seat.js';
import {
  RunnerCallRoleSchema,
  RunnerCallUsageSchema,
  RunnerCallUsageSemanticsSchema,
} from '../../calls/schema.js';
import type { RunnerCallContext, RunnerCallUsage } from '../../calls/types.js';
import { accumulateRunnerCallUsage } from '../../calls/usage.js';
import { addRunnerCallUsageToTokenUsage } from '../tokens.js';

type RunnerCallRole = RunnerCallContext['role'];

// Seats the ledger books on their own: the higher of booked and observed, never their sum.
const SEAT_OPTIONAL_FIELDS = [
  'implementerCacheRead',
  'implementerCacheCreate',
  'implementerReasoning',
  'escalationCacheRead',
  'escalationCacheCreate',
  'escalationReasoning',
] as const satisfies readonly (keyof TokenUsage)[];

const POOLED_OPTIONAL_FIELDS = [
  ['plannerCacheRead', 'reviewerCacheRead'],
  ['plannerCacheCreate', 'reviewerCacheCreate'],
  ['plannerReasoning', 'reviewerReasoning'],
] as const satisfies readonly (readonly [keyof TokenUsage, keyof TokenUsage])[];

const COVERAGE_FIELDS = [
  'plannerCoverage',
  'implementerCoverage',
  'escalationCoverage',
  'reviewerCoverage',
] as const satisfies readonly (keyof TokenUsage)[];

type ReconcileTokenUsageOptions = {
  ref: SessionRef;
  booked: TokenUsage;
};

// The workflow ledger (state.tokenUsage) is credited only on the success path of each
// phase flow, so a run that fails after a call completed loses that call's tokens.
// The session log keeps every runner_call usage record, so the summary reconciles the
// ledger against it: booked figures are never reduced, and observed usage the ledger
// never booked is added on top.
export function reconcileTokenUsageWithSessionLog(opts: ReconcileTokenUsageOptions): TokenUsage {
  const { ref, booked } = opts;
  const observed = observedTokenUsageFromSessionLog(ref);
  if (observed === null) return booked;
  return reconcileTokenUsage(booked, observed);
}

export function reconcileTokenUsage(booked: TokenUsage, observed: TokenUsage): TokenUsage {
  // A session written before the review seat existed books its final review onto the planner,
  // so planner and reviewer reconcile as one pool; each seat is then credited only the part of
  // the shortfall the log shows that seat spending beyond the ledger.
  const input = splitShortfall({
    booked: { planner: booked.plannerInput, reviewer: booked.reviewerInput },
    observed: { planner: observed.plannerInput, reviewer: observed.reviewerInput },
  });
  const output = splitShortfall({
    booked: { planner: booked.plannerOutput, reviewer: booked.reviewerOutput },
    observed: { planner: observed.plannerOutput, reviewer: observed.reviewerOutput },
  });

  const reconciled: TokenUsage = {
    plannerInput: booked.plannerInput + input.planner,
    plannerOutput: booked.plannerOutput + output.planner,
    implementerInput: Math.max(booked.implementerInput, observed.implementerInput),
    implementerOutput: Math.max(booked.implementerOutput, observed.implementerOutput),
    escalationInput: Math.max(booked.escalationInput, observed.escalationInput),
    escalationOutput: Math.max(booked.escalationOutput, observed.escalationOutput),
    reviewerInput: booked.reviewerInput + input.reviewer,
    reviewerOutput: booked.reviewerOutput + output.reviewer,
  };
  for (const key of SEAT_OPTIONAL_FIELDS) {
    const value = maxOptional(booked[key], observed[key]);
    if (value !== undefined) reconciled[key] = value;
  }
  // The log holds every call the run made, so its description of a seat is the more complete one.
  // Where it describes nothing the booked word stands, and a record with neither stays unknown.
  for (const key of COVERAGE_FIELDS) {
    const coverage = observed[key] ?? booked[key];
    if (coverage !== undefined) reconciled[key] = coverage;
  }
  for (const [plannerKey, reviewerKey] of POOLED_OPTIONAL_FIELDS) {
    const credit = splitShortfall({
      booked: { planner: booked[plannerKey] ?? 0, reviewer: booked[reviewerKey] ?? 0 },
      observed: { planner: observed[plannerKey] ?? 0, reviewer: observed[reviewerKey] ?? 0 },
    });
    for (const [key, seatCredit] of [
      [plannerKey, credit.planner],
      [reviewerKey, credit.reviewer],
    ] as const) {
      const bookedValue = booked[key];
      if (bookedValue === undefined && seatCredit === 0) continue;
      reconciled[key] = (bookedValue ?? 0) + seatCredit;
    }
  }
  return reconciled;
}

type PooledSeats = Readonly<{ planner: number; reviewer: number }>;

function splitShortfall(input: Readonly<{ booked: PooledSeats; observed: PooledSeats }>): {
  planner: number;
  reviewer: number;
} {
  const { booked, observed } = input;
  const shortfall = Math.max(
    0,
    observed.planner + observed.reviewer - (booked.planner + booked.reviewer),
  );
  const reviewer = Math.min(shortfall, Math.max(0, observed.reviewer - booked.reviewer));
  return { planner: shortfall - reviewer, reviewer };
}

const UsageLogEntrySchema = z.looseObject({
  kind: z.literal('event'),
  type: z.enum([
    'runner_call_started',
    'runner_call_usage',
    'runner_call_completed',
    'runner_call_error',
  ]),
  phase: PhaseSchema.optional(),
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
  started: boolean;
};

// The ledger books planning-time review calls onto the planner.
function seatRoleForCall(
  input: Readonly<{ role: RunnerCallRole; phase: Phase | undefined }>,
): RunnerCallRole {
  if (input.role !== 'review') return input.role;
  return isReviewSeatCall(input) ? 'review' : 'planner';
}

function observedTokenUsageFromSessionLog(ref: SessionRef): TokenUsage | null {
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE);
  if (!existsSync(filePath)) return null;

  const calls: CallUsageFold[] = [];
  const current = new Map<string, CallUsageFold>();
  try {
    // The summary path is synchronous, so it cannot consume the canonical async
    // reader in core/sessions/log-reader.ts; it carries that reader's two guards
    // instead — a symlinked log is refused, an oversized entry is skipped.
    if (lstatSync(filePath).isSymbolicLink()) return null;
    forEachLineSync(filePath, (line) => {
      if (!line.includes('"runner_call_')) return;
      if (Buffer.byteLength(line, 'utf8') > SESSION_LOG_MAX_ENTRY_BYTES) return;
      const parsedLine = parseJsonlLine(line);
      if (parsedLine.kind !== 'value') return;
      const entry = UsageLogEntrySchema.safeParse(parsedLine.value);
      if (!entry.success) return;

      const { callId, role } = entry.data.data;
      const isStart = entry.data.type === 'runner_call_started';
      let call = current.get(callId);
      if (call === undefined || (isStart && (call.started || call.terminal))) {
        call = {
          role: seatRoleForCall({ role, phase: entry.data.phase }),
          usage: null,
          terminal: false,
          started: false,
        };
        calls.push(call);
        current.set(callId, call);
      }
      if (isStart) {
        call.started = true;
        return;
      }
      // Mirror the collector: samples after a terminal record are ignored, and a
      // terminal record's usage (when present) applies as final.
      if (call.terminal) return;
      const isTerminal = entry.data.type !== 'runner_call_usage';
      if (isTerminal) call.terminal = true;
      const usage = RunnerCallUsageSchema.safeParse(entry.data.data.usage);
      const semantics = RunnerCallUsageSemanticsSchema.safeParse(
        isTerminal ? 'final' : entry.data.data.semantics,
      );
      if (usage.success && semantics.success) {
        call.usage = accumulateRunnerCallUsage(call.usage, usage.data, semantics.data);
      }
    });
  } catch {
    // Best-effort: an invalid session id or unreadable log never blocks the summary.
    return null;
  }
  if (calls.length === 0) return null;

  const observed: TokenUsage = { ...ZERO_TOKEN_USAGE };
  for (const call of calls) {
    if (call.usage !== null) addRunnerCallUsageToTokenUsage(observed, call.role, call.usage);
  }
  return observed;
}

function maxOptional(booked: number | undefined, observed: number | undefined): number | undefined {
  if (booked === undefined && observed === undefined) return undefined;
  return Math.max(booked ?? 0, observed ?? 0);
}

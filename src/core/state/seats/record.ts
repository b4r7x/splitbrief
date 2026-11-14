/**
 * The seat file records the crew the session last ran with, one formatted
 * identity per seat, so a resume can say what changed under the run instead of
 * silently continuing on a different tool. Every run that actually starts
 * rewrites it (`reconcileSeatIdentities`), so the comparison is against the
 * previous run and not against the first; a resume that never gets past
 * preparation leaves the record alone. It sits beside state.json rather than
 * inside it because a seat identity is a display string, not machine state the
 * state machine transitions over.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { confinedReadFile, confinedWriteFile } from '../../../lib/fs/confined.js';
import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { type CrewSeatId, REVIEW_NONE, formatSeatIdentity } from '../../crew/identity.js';
import { seatIdsOf, type SeatIds, sameSeatIds } from '../../crew/seat-ids.js';
import { deriveCrewSeats } from '../../crew/seats.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, SEATS_FILE } from '../../paths.js';
import { resolveCliModel } from '../../providers/automatic-model.js';
import { resolveAutoModel } from '../../providers/model-selection.js';
import type { SeatIdentity } from '../../providers/seat-identity.js';
import type { Config } from '../../schemas/config.js';
import { RUNNER_KINDS } from '../../schemas/enums.js';
import type { RecoveryIssue } from '../../schemas/recovery/schemas.js';
import type { WorkflowState } from '../../schemas/workflow/state.js';
import { assertSessionDirConfined } from '../../sessions/confinement.js';
import { sessionError } from '../../sessions/errors.js';
import type { SessionRef } from '../../types/session-ref.js';
import { loadState } from '../persistence.js';

const SeatIdsSchema = z.object({
  tool: z.string(),
  model: z.string().optional(),
  axes: z.array(z.string()).readonly(),
  kind: z.enum(RUNNER_KINDS).optional(),
});

export const SeatIdentitiesSchema = z.object({
  plan: z.string(),
  build: z.string(),
  review: z.string(),
  /**
   * The ids each identity was spelled from, so a notice can name both sides of a move in the
   * catalog's words. The ids are the comparison: a model the catalog renames never reads as a
   * seat that moved. Records written before these were kept have none and compare by identity,
   * and records written before the runner kind was kept carry ids without one.
   */
  ids: z.object({ plan: SeatIdsSchema, build: SeatIdsSchema, review: SeatIdsSchema }).optional(),
  /**
   * Whose seat REVIEW was: its `own`, PLAN's (`plan`), or `none`. The ids cannot say it: a reviewer
   * set to the planner's tool and model has the same ids. Records written before it have none.
   */
  reviewSeat: z.enum(['own', 'plan', 'none']).optional(),
  /**
   * The BUILD profiles other than the default, by name: a brief routed to one runs on its seat, so
   * a move there is a move of the BUILD seat too. Absent when the config names no other profile.
   */
  buildProfiles: z
    .record(z.string(), z.object({ identity: z.string(), ids: SeatIdsSchema }))
    .optional(),
});

export type SeatIdentities = z.infer<typeof SeatIdentitiesSchema>;

const SeatIdentityRecordSchema = SeatIdentitiesSchema.extend({
  switchCount: z.number().int().nonnegative().optional(),
  /** The older spelling of `reviewSeat`, read from records written before it. */
  reviewFollowsPlan: z.boolean().optional(),
});

const REVIEW_SEAT_OF_SOURCE = { configured: 'own', planner: 'plan', none: 'none' } as const;

/** The crew as the surfaces spell it: `displayNames` are the catalog labels the crew rows show. */
export function seatIdentitiesFromConfig(
  config: Config,
  displayNames?: Partial<Record<CrewSeatId, string>>,
): SeatIdentities {
  const [plan, build, review] = deriveCrewSeats({ config, displayNames });
  const otherProfiles = resolveImplementerProfiles(config).profiles.filter(
    (profile) => !profile.isDefault,
  );
  return {
    plan: plan.model,
    build: build.model,
    review: review.model,
    ids: {
      plan: seatIdsOf(plan.runner),
      build: seatIdsOf(build.runner),
      review:
        review.source === 'none' ? { tool: REVIEW_NONE.mark, axes: [] } : seatIdsOf(review.runner),
    },
    reviewSeat: REVIEW_SEAT_OF_SOURCE[review.source],
    ...(otherProfiles.length > 0 && {
      buildProfiles: Object.fromEntries(
        otherProfiles.map((profile) => [
          profile.name,
          {
            identity: formatSeatIdentity({ seat: profile.config }),
            ids: seatIdsOf(profile.config),
          },
        ]),
      ),
    }),
  };
}

function seatsRelativePath(sessionId: string): string {
  return join(SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, SEATS_FILE);
}

export function readSeatIdentityRecord(
  ref: SessionRef,
): Omit<z.infer<typeof SeatIdentityRecordSchema>, 'reviewFollowsPlan'> | null {
  const raw = confinedReadFile(ref.projectDir, seatsRelativePath(ref.sessionId));
  if (raw === null) return null;
  try {
    const parsed = SeatIdentityRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { reviewFollowsPlan, ...record } = parsed.data;
    return reviewFollowsPlan === undefined
      ? record
      : { ...record, reviewSeat: reviewFollowsPlan ? 'plan' : 'own' };
  } catch {
    return null;
  }
}

export function readSeatIdentities(ref: SessionRef): SeatIdentities | null {
  const record = readSeatIdentityRecord(ref);
  if (record === null) return null;
  const { switchCount: _switchCount, ...seats } = record;
  return seats;
}

export function writeSeatIdentities(ref: SessionRef, seats: SeatIdentities): void {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  // Switches append to state before resume records the crew; this count preserves that order.
  const switchCount = loadState(ref)?.seatSwitches?.length ?? 0;
  confinedWriteFile(
    ref.projectDir,
    seatsRelativePath(ref.sessionId),
    `${JSON.stringify({ ...seats, switchCount }, null, 2)}\n`,
  );
}

/** Records the seats a run starts on; a session that already has a record keeps it. */
export function recordSeatIdentities(
  ref: SessionRef,
  config: Config,
  displayNames?: Partial<Record<CrewSeatId, string>>,
): void {
  if (readSeatIdentities(ref) !== null) return;
  writeSeatIdentities(ref, seatIdentitiesFromConfig(config, displayNames));
}

/**
 * The seat a halt's call ran on: the call the halt recorded when it offered another tool, else the
 * seat the run's latest pass started on, the halted profile's own seat for a BUILD halt on a named
 * profile. A halt that names no seat, or a run whose record kept no ids, names none.
 */
export function haltedSeatIds(ref: SessionRef, issue: RecoveryIssue): SeatIds | null {
  if (issue.seat === undefined) return null;
  const from = issue.switchSeat?.from;
  if (from !== undefined) return { tool: from.tool, model: from.model };
  const record = readSeatIdentities(ref);
  if (record?.ids === undefined) return null;
  const profile = issue.seat === 'build' ? issue.selectedImplementerProfile : undefined;
  const profileIds = profile === undefined ? undefined : record.buildProfiles?.[profile]?.ids;
  return profileIds ?? record.ids[issue.seat];
}

function recordedModel(seat: SeatIds): string | undefined {
  return seat.kind === 'api'
    ? resolveAutoModel(seat.model, seat.tool)
    : resolveCliModel(seat.model, seat.tool);
}

/**
 * The crew a run ran with, for its closed record: the seats of its latest pass, never the config
 * saved since. The planner holds the review seat when the record says it followed PLAN, and no seat
 * holds it when the record says None. A record
 * written before that was kept reads it as following PLAN only when both seats are the same and
 * the run started without a reviewer. A record written before seat ids were kept reads the seats
 * the state saved at the run's start.
 */
export function recordedSeatIdentity(ref: SessionRef, state: WorkflowState): SeatIdentity {
  const record = readSeatIdentities(ref);
  if (record?.ids === undefined) {
    if (state.plannerTool === undefined || state.implementerTool === undefined) {
      throw sessionError.invalidData(ref.sessionId, 'the run recorded no crew');
    }
    return {
      plannerTool: state.plannerTool,
      plannerModel: state.plannerModel,
      plannerKind: state.plannerKind,
      implementerTool: state.implementerTool,
      implementerModel: state.implementerModel,
      implementerKind: state.implementerKind,
      reviewerTool: state.reviewerTool,
      reviewerModel: state.reviewerModel,
      reviewerKind: state.reviewerKind,
    };
  }
  const ids = record.ids;
  const reviewSeat =
    record.reviewSeat ??
    (state.reviewerTool === undefined && sameSeatIds(ids.review, ids.plan) ? 'plan' : 'own');
  return {
    plannerTool: ids.plan.tool,
    plannerModel: recordedModel(ids.plan),
    plannerKind: ids.plan.kind,
    plannerAxes: ids.plan.axes,
    implementerTool: ids.build.tool,
    implementerModel: recordedModel(ids.build),
    implementerKind: ids.build.kind,
    implementerAxes: ids.build.axes,
    ...(reviewSeat === 'own' && {
      reviewerTool: ids.review.tool,
      reviewerModel: recordedModel(ids.review),
      reviewerKind: ids.review.kind,
      reviewerAxes: ids.review.axes,
    }),
    ...(reviewSeat === 'none' && { reviewerSeat: 'none' }),
  };
}

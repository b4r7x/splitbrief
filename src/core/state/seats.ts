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
import type { Config } from '../schemas/config.js';
import { CREW_SEAT_IDS, CREW_SEAT_LABELS } from '../crew/identity.js';
import type { CrewSeatId } from '../crew/identity.js';
import { deriveCrewSeats } from '../crew/seats.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, SEATS_FILE } from '../paths.js';
import type { SessionRef } from '../types/session-ref.js';
import { confinedReadFile, confinedWriteFile } from '../../lib/confined-fs.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';

export const SeatIdentitiesSchema = z.object({
  plan: z.string(),
  build: z.string(),
  review: z.string(),
});

export type SeatIdentities = z.infer<typeof SeatIdentitiesSchema>;

export type SeatChange = Readonly<{ seat: CrewSeatId; before: string; after: string }>;

export function seatIdentitiesFromConfig(config: Config): SeatIdentities {
  const [plan, build, review] = deriveCrewSeats({ config });
  return { plan: plan.model, build: build.model, review: review.model };
}

function seatsRelativePath(sessionId: string): string {
  return join(SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, SEATS_FILE);
}

export function readSeatIdentities(ref: SessionRef): SeatIdentities | null {
  const raw = confinedReadFile(ref.projectDir, seatsRelativePath(ref.sessionId));
  if (raw === null) return null;
  try {
    const parsed = SeatIdentitiesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeSeatIdentities(ref: SessionRef, seats: SeatIdentities): void {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  confinedWriteFile(
    ref.projectDir,
    seatsRelativePath(ref.sessionId),
    `${JSON.stringify(seats, null, 2)}\n`,
  );
}

/** Records the seats a run starts on; a session that already has a record keeps it. */
export function recordSeatIdentities(ref: SessionRef, config: Config): void {
  if (readSeatIdentities(ref) !== null) return;
  writeSeatIdentities(ref, seatIdentitiesFromConfig(config));
}

export function seatIdentityChanges(
  recorded: SeatIdentities | null,
  current: SeatIdentities,
): SeatChange[] {
  if (recorded === null) return [];
  const changes: SeatChange[] = [];
  for (const seat of CREW_SEAT_IDS) {
    if (recorded[seat] === current[seat]) continue;
    changes.push({ seat, before: recorded[seat], after: current[seat] });
  }
  return changes;
}

export function formatSeatChangeNotice(change: SeatChange): string {
  const consequence =
    change.seat === 'plan' ? 'context will be rebuilt' : 'the rest of the run uses the new seat';
  return `${CREW_SEAT_LABELS[change.seat]} seat changed ${change.before} → ${change.after}; ${consequence}`;
}

/**
 * The one home for maintaining the record: it reports what moved since the last
 * run and re-records the crew this run is about to use, so every resume — CLI
 * or in-app — compares against the run that really happened.
 */
export function reconcileSeatIdentities(ref: SessionRef, config: Config): SeatChange[] {
  const current = seatIdentitiesFromConfig(config);
  const changes = seatIdentityChanges(readSeatIdentities(ref), current);
  if (changes.length > 0) writeSeatIdentities(ref, current);
  return changes;
}

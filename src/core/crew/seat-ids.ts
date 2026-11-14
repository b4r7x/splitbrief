import { type RunnerConfig, getRunnerDisplayName } from '../config/accessors/runner-config.js';
import { resolveCliModel } from '../providers/automatic-model.js';
import { cliVocabularyTool } from '../providers/model-display.js';
import { isCliToolId } from '../runners/cli-tool/catalog.js';
import { recordedAxisWords, seatAxisWords } from '../runners/effort-channel.js';
import type { RunnerKind } from '../schemas/enums.js';

/**
 * A seat named by ids rather than by its runner block: the tool or provider word,
 * the configured model, the axis words the seat
 * carries and the backend it ran on. A run records its seats this way, and both
 * forms below read a configured runner through the same shape, so a recorded
 * seat is spelled exactly as the seat it was taken from.
 */
export type SeatIds = Readonly<{
  tool: string;
  model?: string | undefined;
  axes?: readonly string[] | undefined;
  /** The backend the seat ran on; a record written before kinds were kept has none. */
  kind?: RunnerKind | undefined;
}>;

export function isSeatIdentity(
  seat: Readonly<{ tool: string; model?: string | undefined }>,
  candidate: Readonly<{ tool: string; model?: string | undefined }>,
): boolean {
  if (candidate.tool !== seat.tool) return false;
  const model = resolveCliModel(candidate.model, candidate.tool);
  return model === undefined || model === resolveCliModel(seat.model, seat.tool);
}

export function recordedAxes(seat: SeatIds, kind: RunnerKind | undefined): readonly string[] {
  const tool = cliVocabularyTool(seat.tool, kind);
  const axes = seat.axes ?? [];
  return tool === undefined ? axes : recordedAxisWords(tool, seat.model, axes);
}

/**
 * Two recorded seats are the same seat when their ids match: a catalog that renames the model
 * changes the identity, not the seat. The axes compare by the level that runs, so a record
 * that left out the level its id spells still matches. A side recorded before kinds were kept
 * matches any kind.
 */
export function sameSeatIds(left: SeatIds, right: SeatIds): boolean {
  return (
    left.tool === right.tool &&
    resolveCliModel(left.model, left.tool) === resolveCliModel(right.model, right.tool) &&
    recordedAxes(left, left.kind).join(' ') === recordedAxes(right, right.kind).join(' ') &&
    (left.kind === undefined || right.kind === undefined || left.kind === right.kind)
  );
}

export function seatIdsOf(runner: RunnerConfig): SeatIds & Readonly<{ axes: readonly string[] }> {
  return {
    tool: getRunnerDisplayName(runner),
    ...('model' in runner && runner.model !== undefined && { model: runner.model }),
    axes: seatAxisWords(runner),
    kind: runner.kind,
  };
}

/**
 * Recorded ids are the shape that carries axis words: `seatIdsOf` always writes
 * them and the persisted schema requires them, while a live runner block never
 * has any. Ids written by hand may keep neither axes nor kind, so an object
 * without a kind is recorded ids too.
 */
function isSeatIds(seat: RunnerConfig | SeatIds): seat is SeatIds {
  if ('axes' in seat) return true;
  if (!('kind' in seat)) return true;
  // A live cli runner and a recorded cli identity both name a tool, so only the axis
  // words above tell those apart — and only for a catalog tool: the live schema admits
  // catalog ids alone, so a kind-qualified cli record whose tool left the catalog is a
  // record, never a live block whose axis lookup would dereference an absent entry.
  // Every other kind's live block is named by its own fields (an api runner by provider,
  // a command runner by command), never by the tool word a recorded identity keeps, so a
  // kind-qualified record without axes is still ids.
  return 'tool' in seat && (seat.kind !== 'cli' || !isCliToolId(seat.tool));
}

export function idsOf(seat: RunnerConfig | SeatIds): SeatIds {
  return isSeatIds(seat) ? seat : seatIdsOf(seat);
}

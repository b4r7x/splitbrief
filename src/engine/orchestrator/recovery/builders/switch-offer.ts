import type {
  DeepReadonly,
  RunnerConfig,
} from '../../../../core/config/accessors/runner-config.js';
import { automaticSwitchUsed } from '../../../../core/crew/fallback.js';
import { sameSeatCandidate, type CrewSeatId } from '../../../../core/crew/identity.js';
import { isSeatIdentity } from '../../../../core/crew/seat-ids.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import {
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../../core/runners/cli-tool/catalog.js';
import {
  type RouteRefusal,
  routeRefusal,
  type ModelRefusal,
} from '../../../../core/runners/route-auth.js';
import { runnerRoleForActiveRole } from '../../../../core/runners/seat-roles.js';
import type {
  SwitchSeatOffer,
  SeatSwapCandidate,
} from '../../../../core/schemas/recovery/schemas.js';
import type { SeatSwitchRecord } from '../../../../core/schemas/workflow/seat.js';
import { includes } from '../../../../utils/type-guards.js';
import { modelRefusalMessage } from '../../../runners/auth-failure.js';
import { cliPromptLimit } from '../../../runners/cli-tools/registry.js';
import type { PromptLength } from '../../../runners/input-limit.js';
import type { SeatSwapContext } from '../seat/swap-context.js';

/**
 * The ready tools this seat could move to, current identity excluded, each
 * identity named once, and only tools the seat's own role admits — the seat's
 * schema would refuse the rest after the operator picked one. Returns undefined —
 * never an empty offer — when the machine has nothing else detected, so the
 * caller omits the action entirely.
 */
export function switchSeatOffer(
  context: SeatSwapContext | undefined,
  promptSize?: PromptLength,
): SwitchSeatOffer | undefined {
  if (context === undefined) return undefined;
  const hostable = seatHostableTools(context.seat);
  const role = seatRunnerRole(context.seat);
  const seen = new Set<string>();
  const candidates: SeatSwapCandidate[] = [];
  for (const detected of context.detectedTools) {
    if (!detected.ready) continue;
    if (!includes(hostable, detected.tool)) continue;
    if (isSeatIdentity({ tool: context.currentTool, model: context.currentModel }, detected))
      continue;
    const identity = `${detected.tool}\u0000${detected.model ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push({
      tool: detected.tool,
      ...(detected.model !== undefined && { model: detected.model }),
      ...(detected.effort !== undefined && { effort: detected.effort }),
      ...(detected.variant !== undefined && { variant: detected.variant }),
    });
  }
  const offered =
    promptSize === undefined ? candidates : takingPrompt(candidates, role, promptSize);
  if (offered.length === 0) return undefined;
  return {
    seat: context.seat,
    ...(context.from !== undefined && { from: context.from }),
    candidates: offered,
  };
}

/** The candidates whose tool takes a prompt of this size: tools without a limit first. */
function takingPrompt(
  candidates: readonly SeatSwapCandidate[],
  role: 'planner' | 'implementer',
  promptSize: PromptLength,
): SeatSwapCandidate[] {
  const unlimited: SeatSwapCandidate[] = [];
  const fitting: SeatSwapCandidate[] = [];
  for (const candidate of candidates) {
    const limit = cliPromptLimit(role, candidate.tool);
    if (limit === undefined) unlimited.push(candidate);
    else if (promptSize[limit.unit] <= limit.max) fitting.push(candidate);
  }
  return [...unlimited, ...fitting];
}

function seatRunnerRole(seat: CrewSeatId): 'planner' | 'implementer' {
  return runnerRoleForActiveRole(CREW_SEAT_ROLES[seat]) === 'implementer'
    ? 'implementer'
    : 'planner';
}

function seatHostableTools(seat: CrewSeatId): readonly string[] {
  return seatRunnerRole(seat) === 'implementer' ? IMPLEMENTER_CLI_TOOL_IDS : PLANNER_CLI_TOOL_IDS;
}

/**
 * A model refusal's offer: the other tools, then the seat's own tool without a
 * model, so taking it opens the seat's picker on that tool to pick a listed
 * model. It comes last, so a declared fallback still leads.
 */
function modelRefusalSeatOffer(context: SeatSwapContext | undefined): SwitchSeatOffer | undefined {
  const offer = switchSeatOffer(context);
  if (context === undefined || !includes(seatHostableTools(context.seat), context.currentTool)) {
    return offer;
  }
  return {
    seat: context.seat,
    ...(context.from !== undefined && { from: context.from }),
    candidates: [...(offer?.candidates ?? []), { tool: context.currentTool }],
  };
}

/**
 * Whether a seat that cannot work moves to its declared fallback now, without asking: only when
 * the offer leads with that fallback — the halt can take it and the seat does not run it already —
 * and this run has not already switched the seat automatically. The seat call and the seat-down
 * halt both decide here, so a seat that does not move waits for its reset or halts with the panel.
 * The config hash travels with the intent so a config the operator changed is not overwritten.
 */
export function automaticSeatSwitch(
  seatSwap: SeatSwapContext | undefined,
  seatSwitches: readonly SeatSwitchRecord[] | undefined,
): NonNullable<SwitchSeatOffer['auto']> | undefined {
  if (seatSwap === undefined) return undefined;
  const { fallback, configRevision } = seatSwap;
  if (fallback === undefined || configRevision === undefined) return undefined;
  if (automaticSwitchUsed(seatSwitches, seatSwap.seat)) return undefined;
  const first = switchSeatOffer(seatSwap)?.candidates[0];
  if (first === undefined || !sameSeatCandidate(first, fallback)) return undefined;
  return { candidate: fallback, configRevision };
}

/**
 * What a model refusal means for the halted seat: the one decision every
 * missing-model halt reads. OpenCode refuses a route with no credential and a
 * misspelled model, an unavailable variant or a broken provider setup alike
 * (`provider.no-route`), so the words never decide alone: the route's own
 * credential listing does. A seat with no listing to ask reads as a model the
 * tool does not list.
 */
export function seatRouteRefusal(seatSwap: SeatSwapContext | undefined): RouteRefusal {
  return seatSwap?.routeAuth === undefined
    ? { kind: 'wrong-model' }
    : routeRefusal(seatSwap.routeAuth);
}

/**
 * The offer and the message of a model refusal that is not a sign-out. Another
 * seat is the recommended move, never a retry: every attempt reaches the same
 * refusal until the seat names a listed model.
 */
export function modelRefusalHalt(
  runner: DeepReadonly<RunnerConfig>,
  refusal: ModelRefusal,
  seatSwap: SeatSwapContext | undefined,
): Readonly<{ message: string; offer: SwitchSeatOffer | undefined }> {
  return { message: modelRefusalMessage(runner, refusal), offer: modelRefusalSeatOffer(seatSwap) };
}

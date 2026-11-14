import { getProviderDisplayName } from '../../../../core/providers/catalog.js';
import { commitSeatSwitch } from '../seat/switch/commit.js';
import { planSwitchSeatRecoveryAction } from '../seat/switch/plan.js';
import { blockRecoveryAction } from './shared.js';
import type { ApplyRecoveryActionOptions, ApplySwitchSeatResult } from './types.js';

/**
 * The command line's switch: the plan, then the state commit. The command writes
 * the one-seat config file itself, through the same revision-checked writer the
 * run loop uses, once this has resolved the halt. The swap travels back as
 * `switchedConfig`, which the caller hands to the seat factories.
 *
 * The command line names the tool as text, so it has to be one the halt offered;
 * the model, effort and variant stay the operator's choice. The seat's picker
 * lists every tool the seat admits, so its pick is not checked against the offer.
 */
export function applySwitchSeatRecoveryAction(
  opts: Omit<ApplyRecoveryActionOptions, 'action'>,
): ApplySwitchSeatResult {
  const issue = opts.state.pendingRecovery;
  const offer = issue?.switchSeat;
  const chosen = opts.candidate;
  if (
    issue !== undefined &&
    offer !== undefined &&
    chosen !== undefined &&
    !offer.candidates.some((candidate) => candidate.tool === chosen.tool)
  ) {
    return blockRecoveryAction({
      ...opts,
      action: 'switch-seat',
      issue,
      code: 'candidate-not-offered',
      message: `${getProviderDisplayName(chosen.tool)} is not one of the tools offered for the ${offer.seat} seat.`,
      publishSelected: true,
    });
  }
  let state = opts.state;
  if (issue !== undefined && offer?.auto !== undefined) {
    const { auto: _auto, ...unattended } = offer;
    state = { ...opts.state, pendingRecovery: { ...issue, switchSeat: unattended } };
  }
  const planned = planSwitchSeatRecoveryAction({ ...opts, state });
  if (!planned.ok) return planned;
  const configRevision = planned.plan.configRevision ?? '';
  const choice = { auto: false, configRevision };
  return commitSeatSwitch({ ...opts, action: 'switch-seat' }, planned.plan, choice);
}

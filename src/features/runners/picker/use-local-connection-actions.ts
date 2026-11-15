import {
  readActiveRunner,
  updateActiveRunner,
} from '../../../core/config/accessors/active-runner.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { buildRunnerConfig } from '../../../core/config/runtime/build-runner.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import type { ApiProviderId } from '../../../core/providers/api-catalog.js';
import { getKnownProviderBaseURL } from '../../../core/providers/catalog.js';
import {
  PICKER_ROLE_SEAT_IDS,
  seatPickerLane,
  type ActiveRunnerRole,
  type SeatPickerRole,
} from '../../../core/runners/seat-roles.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ImplementerConfig } from '../../../core/schemas/runner/implementer.js';
import type { PlannerConfig } from '../../../core/schemas/runner/planner.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { configStore } from '../../../stores/project/config.js';
import {
  reportConfigSaveFailure,
  formatConfigSaveSuccess,
} from '../../../stores/project/save-feedback.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import type {
  LocalConnectionSeat,
  LocalConnectionProbe,
  LocalConnectionSave,
} from '../local-connection/model.js';
import { type PickerEffectDeps, defaultPickerEffectDeps, reportFailure } from './use-actions.js';
import { usePickerProfile } from './profile.js';
import { savedSeatIdentity } from './seat-identity.js';

/** The three functions the local-server form is driven by, and nothing else. */
export interface LocalConnectionActions {
  /** The seat's own connection; a review seat never reads the planner's. */
  seat(provider: ApiProviderId): LocalConnectionSeat;
  /** The read-only catalog probe Check and Retry spend; it runs no model. */
  check: LocalConnectionProbe;
  save(input: LocalConnectionSave): Promise<void>;
}

/**
 * The block the seat owns, never the one it falls back to: an unconfigured review seat
 * resolves to the planner's runner, and reading that here would prefill REVIEW with
 * PLAN's address.
 */
function seatOwnRunner(
  config: Config,
  role: ActiveRunnerRole,
  profile: string | undefined,
): PlannerConfig | ImplementerConfig | undefined {
  if (role === 'planner') return config.planner;
  if (role === 'reviewer') return configuredReviewerRunner(config);
  return readActiveRunner({ config, role: 'implementer', profile });
}

/**
 * A cleared token reference is a removal, and `buildRunnerConfig` would inherit the old
 * one instead: the seat's own block decides, so the drop happens after it is built.
 */
function dropClearedPlannerToken(runner: PlannerConfig, apiKey: string | undefined): PlannerConfig {
  if (apiKey !== undefined || runner.kind !== 'api' || runner.apiKey === undefined) return runner;
  const { apiKey: _cleared, ...rest } = runner;
  return rest;
}

function dropClearedImplementerToken(
  runner: ImplementerConfig,
  apiKey: string | undefined,
): ImplementerConfig {
  if (apiKey !== undefined || runner.kind !== 'api' || runner.apiKey === undefined) return runner;
  const { apiKey: _cleared, ...rest } = runner;
  return rest;
}

/**
 * The local-server form's own ports. They sit beside `usePickerActions` rather than
 * inside it: the form is the only caller, and every other picker surface would have to
 * carry three members it never spends.
 */
export function useLocalConnectionActions(
  role: SeatPickerRole,
  deps: PickerEffectDeps = defaultPickerEffectDeps,
): LocalConnectionActions {
  const seatRole: ActiveRunnerRole = seatPickerLane(role);
  const config = configStore.useConfig();
  const profile = usePickerProfile();
  const roleLabel = CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]];

  return {
    seat(provider: ApiProviderId): LocalConnectionSeat {
      const own = seatOwnRunner(config, seatRole, profile);
      const configured = own?.kind === 'api' && own.provider === provider ? own : undefined;
      return {
        apiBase: configured?.apiBase ?? getKnownProviderBaseURL(provider),
        ...(configured?.apiKey === undefined ? {} : { apiKey: configured.apiKey }),
        ...(configured?.model === undefined ? {} : { model: configured.model }),
      };
    },
    check: deps.checkConnection,
    save(input: LocalConnectionSave) {
      return reportFailure(async () => {
        const opts = {
          kind: 'api' as const,
          tool: input.provider,
          apiBase: input.apiBase,
          ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
          model: input.model,
        };
        // The seat's own block, so a saved REVIEW address never lands on the planner.
        const updated =
          seatRole === 'implementer'
            ? updateActiveRunner({
                config,
                role: 'implementer',
                profile,
                updater: (existing) =>
                  dropClearedImplementerToken(
                    buildRunnerConfig('implementer', { ...opts, existing }),
                    input.apiKey,
                  ),
              })
            : updateActiveRunner({
                config,
                role: seatRole,
                updater: (existing) =>
                  dropClearedPlannerToken(
                    buildRunnerConfig(seatRole, { ...opts, existing }),
                    input.apiKey,
                  ),
              });
        const result = await deps.saveConfig(updated);
        if (reportConfigSaveFailure(result)) return;
        feedbackStore.setMessage(
          formatConfigSaveSuccess(
            `${roleLabel}${SOFT_SEP}${savedSeatIdentity(updated, seatRole, 'seat', profile)}`,
            result,
          ),
        );
        pickerViewStore.setCommitted(true);
        overlayStore.close();
      });
    },
  };
}

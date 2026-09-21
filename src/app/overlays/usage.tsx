import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import type { RunStatus } from '../../core/sessions/run-status.js';
import { usageDetailsForRun } from '../../features/workflow/spend-text.js';
import { deriveUsageDetails } from '../../features/workflow/usage-details-model.js';
import { UsageDetails } from '../../features/workflow/usage-details.js';
import { routerStore } from '../../stores/navigation/router.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { operationsStore } from '../../stores/workflow/operations/state.js';
import { configStore } from '../../stores/project/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';

/** The halt a run is parked on, read off the record that already states how the run stands. */
function haltedIssue(status: RunStatus): RecoveryIssue | null {
  if (status.kind !== 'open' || status.stop.kind !== 'halted') return null;
  return status.stop.issue;
}

/**
 * The `/usage` destination. Counters come from the token store, which a replayed run hydrates
 * exactly as a live one writes it. The money comes from the run's own recorded summary whenever it
 * has one — that is the breakdown priced at the rates the calls actually ran at, and re-pricing it
 * from today's catalog would state a different number than the run earned. A run still going has no
 * summary yet, so it is priced live. A halt is read from wherever it currently is: the notice store
 * while this process holds the panel open on it, the run's own record once it has been written back
 * — `deriveRunStatus` carries the pending issue — so the diagnosis reads the same on a halt just
 * raised and on one reopened days later. It is one issue and one decoder either way. The page
 * starts nothing; closing leaves the run, the draft and the transcript where they were.
 */
export function UsageOverlay() {
  const tokens = tokensStore.use((state) => state);
  const route = routerStore.use((state) => state);
  const config = configStore.use((state) => state.config);
  // Call events refresh the existing operation store before the next render.
  operationsStore.use((state) => state.byCallId);
  modelCacheStore.use((state) => state);
  const open = recoveryNoticeStore.use((state) => state.issue);
  const saved = routerStore.use((state) =>
    state.screen === 'workflow' ? haltedIssue(state.run.status) : null,
  );
  const usage = usageDetailsForRun({ route, tokens, config, modelCache: modelCacheStore });

  return (
    <UsageDetails
      view={deriveUsageDetails({
        ...usage,
        recovery: open ?? saved,
      })}
      onClose={() => overlayStore.close()}
    />
  );
}

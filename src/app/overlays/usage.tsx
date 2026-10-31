import { usageDetailsForRun } from '../../features/workflow/spend-text.js';
import { deriveUsageDetails } from '../../features/workflow/usage-details-model.js';
import { UsageDetails } from '../../features/workflow/usage-details.js';
import { routerStore } from '../../stores/navigation/router.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { runViewStore } from '../../stores/workflow/run-view.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { operationsStore } from '../../stores/workflow/operations/state.js';
import { configStore } from '../../stores/project/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';

/**
 * The `/usage` destination. Counters come from the token store, which a replayed run hydrates
 * exactly as a live one writes it. The money comes from the run's own recorded summary whenever it
 * has one — that is the breakdown priced at the rates the calls actually ran at, and re-pricing it
 * from today's catalog would state a different number than the run earned. A run still going has no
 * summary yet, so it is priced live. A halt is read from the run view, which a live run folds from
 * its log and a run at rest settles from its saved state, so the diagnosis reads the same on a halt
 * just raised and on one reopened days later. The page starts nothing; closing leaves the run, the
 * draft and the transcript where they were.
 */
export function UsageOverlay() {
  const tokens = tokensStore.use((state) => state);
  const route = routerStore.use((state) => state);
  const config = configStore.use((state) => state.config);
  // Call events refresh the existing operation store before the next render.
  operationsStore.use((state) => state.byCallId);
  modelCacheStore.use((state) => state);
  const halt = runViewStore.use((state) => state.halt);
  const usage = usageDetailsForRun({ route, tokens, config, modelCache: modelCacheStore });

  return (
    <UsageDetails
      view={deriveUsageDetails({
        ...usage,
        recovery: halt?.issue ?? null,
      })}
      onClose={() => overlayStore.close()}
    />
  );
}

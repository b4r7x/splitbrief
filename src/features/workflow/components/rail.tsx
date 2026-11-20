import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { TextSpans } from '../../../components/text-spans.js';
import { colorForTone } from '../../../core/theme/tone-color.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { useStores } from '../../../stores/use-many.js';
import type { RailStageState } from '../../../core/phases/rail.js';
import { railConnectorString, railFormBLabel, type RailForm } from '../layout/chrome-rows.js';
import { resolveRailFraction } from '../layout/hit-test.js';
import {
  railFormCSpans,
  resolveRailStages,
  stageLabelTone,
  stageMarkerGlyph,
  stageMarkerTone,
} from '../layout/rail-stages.js';

function RailFormBNode({
  state,
  index,
  short,
}: {
  state: RailStageState;
  index: number;
  short: boolean;
}) {
  const t = useTheme();
  const live = state.status === 'active';
  const label = railFormBLabel(state, { short });
  return (
    <Box>
      {index > 0 && <Text color={t.border}>{railConnectorString()}</Text>}
      <Text color={colorForTone(stageMarkerTone(state), t)} bold={live}>
        {`${stageMarkerGlyph(state.status)} `}
      </Text>
      <Text color={colorForTone(stageLabelTone(state), t)} bold={live}>
        {label}
      </Text>
    </Box>
  );
}

export function RailFormB({ stages, short }: { stages: RailStageState[]; short: boolean }) {
  return (
    <Box height={1} overflow="hidden">
      {stages.map((state, index) => (
        <RailFormBNode key={state.stage} state={state} index={index} short={short} />
      ))}
    </Box>
  );
}

function RailFormC({ stages, fraction }: { stages: RailStageState[]; fraction: string }) {
  return (
    <Box height={1} overflow="hidden">
      <Text>
        <TextSpans parts={railFormCSpans({ stages, fraction })} />
      </Text>
    </Box>
  );
}

export function Rail({
  form,
  short,
  stages: givenStages,
  buildBlockShown = false,
}: {
  form?: RailForm | undefined;
  /** Form B's label variant, which the selector alone chooses. */
  short: boolean;
  buildBlockShown?: boolean | undefined;
  /** A run at rest paints the stages its record names, not the ones a live phase implies. */
  stages?: readonly RailStageState[] | undefined;
}) {
  const [lifecycle, eventsState, { phase, briefs, halt, afterLastBrief }] = useStores(
    lifecycleStore,
    eventsStore,
    runViewStore,
  );
  const cancelled = lifecycle.cancelled;
  const resolved: RailForm = form ?? 'B';
  const stages = [
    ...resolveRailStages({
      phase,
      status: lifecycle.status,
      cancelled,
      pendingRecovery: halt !== null,
      events: eventsState.events,
      recoveryAt: halt?.at ?? null,
      afterLastBrief,
      ...(givenStages !== undefined && { stages: givenStages }),
    }),
  ];
  const fraction = resolveRailFraction({
    phase,
    tasks: briefs,
    cancelled,
    buildBlockShown,
  });

  if (resolved === 'C') {
    return <RailFormC stages={stages} fraction={short ? '' : fraction} />;
  }

  return <RailFormB stages={stages} short={short} />;
}

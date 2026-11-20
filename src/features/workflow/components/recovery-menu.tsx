import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { ListRows } from '../../../components/list-row/rows.js';
import { planListRows } from '../../../components/list-row/plan.js';
import { slashHandoffPending } from '../slash-handoff.js';
import { InlineMenuPanel } from '../inline-menu/panel.js';
import { useInlineMenuKeys } from '../inline-menu/use-keys.js';
import { PROMPT_COMMAND_LEGEND } from '../prompt-rows/approval.js';
import { formatKeyHints, SELECT_HINT } from '../../../components/key-legend.js';
import { RESULT_MENU_UNFOCUSED_LEGEND } from '../result/options.js';
import { PromptBody } from './prompt-body.js';
import { recoveryMenuActionLabel, recoveryMenuRows } from '../recovery/menu-label.js';
import { correctionActionFor } from '../recovery/actions.js';
import { fitRecoveryMenu } from '../prompt-rows/recovery.js';
import { isCommandDraft } from '../../../core/composer/submission.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { selectTaskListView } from '../../../core/run-view/briefs.js';
import { haltReadsNoWords } from '../../../core/run-view/halt.js';

interface RecoveryMenuProps {
  issue: RecoveryIssue;
  width: number;
  clampedBoxRows: number;
  focused: boolean;
  onFocusChange: (menuFocused: boolean) => void;
  onResolve: (answer: string) => void;
}

export function RecoveryMenu({
  issue,
  width,
  clampedBoxRows,
  focused,
  onFocusChange,
  onResolve,
}: RecoveryMenuProps) {
  const t = useTheme();
  const briefFinished = runViewStore.use((view) => selectTaskListView(view.briefs).finished > 0);
  const reviewNone = runViewStore.use((view) => view.reviewNone);
  const stepReadsNone = runViewStore.use(haltReadsNoWords);
  const actions = recoveryMenuRows(issue, briefFinished, reviewNone);
  const lines = planListRows(actions, { width: Math.max(1, width - 4) });
  const initialAction = Math.max(
    0,
    actions.findIndex((item) => item.trailing !== undefined),
  );
  const fit = fitRecoveryMenu({ issue, width, boxRows: clampedBoxRows, actionRows: lines.length });

  // Every action resolves the prompt, `switch-seat` included: the driver answers it by opening
  // the seat's own picker on the offered tool, which is the one place a seat's tool and model are
  // chosen. A tool list here would be a second home for that choice, and a model-less one.
  const chooseAction = (item: (typeof actions)[number]): void => {
    onResolve(item.key);
  };
  const selectedIndex = useInlineMenuKeys({
    items: actions,
    keyOf: (item) => item.action,
    letterOf: (item) => item.key,
    initialIndex: initialAction,
    focused,
    listRows: fit.listRows,
    lines,
    onSelect: chooseAction,
    onTab: () => {
      if (!slashHandoffPending()) onFocusChange(false);
    },
  });

  // Tab hands the keys to the composer, where a letter is a typed letter, so the legend says what ⏎ does there.
  const correctionAction = correctionActionFor(issue, stepReadsNone);
  const commandDraft = composerLiveStore.use((draft) => isCommandDraft(draft.document));
  const composerEmpty = composerLiveStore.use((draft) => draft.empty);
  const composerLegend = commandDraft
    ? PROMPT_COMMAND_LEGEND
    : correctionAction === undefined
      ? 'typing goes to the composer'
      : `⏎ ${recoveryMenuActionLabel(correctionAction, issue, reviewNone)} with the typed correction`;
  const legend = focused
    ? formatKeyHints([
        SELECT_HINT,
        { key: '⏎', verb: 'confirm' },
        ...(correctionAction !== undefined
          ? [{ key: 'tab', verb: 'type a correction' }]
          : composerEmpty
            ? []
            : [{ key: 'tab', verb: 'edit the words' }]),
      ])
    : `${composerLegend}${SOFT_SEP}${RESULT_MENU_UNFOCUSED_LEGEND}`;
  return (
    <InlineMenuPanel
      width={width}
      height={clampedBoxRows}
      framed={fit.framed}
      focused={focused}
      legend={fit.legend ? legend : undefined}
    >
      {fit.summaryRows > 0 && (
        <PromptBody prompt={fit.summary} height={fit.summaryRows} width={fit.innerWidth} />
      )}
      {fit.divided && <Text color={t.border}>{'─'.repeat(fit.innerWidth)}</Text>}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <ListRows
          lines={lines}
          selectedIndex={selectedIndex}
          focused={focused}
          width={fit.innerWidth}
          rowBudget={fit.listRows}
          getKey={(index) => actions[index]?.action ?? ''}
        />
      </Box>
    </InlineMenuPanel>
  );
}

import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { ListRow } from '../../../components/list-row/row.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { colorForTone } from '../../../core/theme/tone-color.js';
import { ListViewport } from '../../../components/pickers/list-viewport.js';
import { slashHandoffPending } from '../slash-handoff.js';
import { InlineMenuPanel } from '../inline-menu/panel.js';
import { useInlineMenuKeys } from '../inline-menu/use-keys.js';
import { PROMPT_COMMAND_LEGEND } from '../prompt-rows/approval.js';
import { formatKeyHints, SELECT_HINT } from '../../../components/key-legend.js';
import { RESULT_MENU_UNFOCUSED_LEGEND } from '../result/options.js';
import { PromptBody } from './prompt-body.js';
import { recoveryMenuActionLabel, recoveryMenuParts } from '../recovery/menu-label.js';
import { recommendedRecoveryAction } from '../recovery/actions.js';
import {
  correctionActionFor,
  getRecoveryPromptActions,
  recoveryActionKey,
} from '../recovery/actions.js';
import { fitRecoveryMenu } from '../prompt-rows/recovery.js';
import { isCommandDraft } from '../../../core/composer/submission.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { selectTaskListView } from '../../../core/run-view/briefs.js';
import { haltReadsNoWords } from '../../../core/run-view/halt.js';

interface ActionItem {
  action: RecoveryAction;
  key: string;
  parts: readonly ConversationRowSegment[];
}

interface RecoveryMenuProps {
  issue: RecoveryIssue;
  width: number;
  clampedBoxRows: number;
  focused: boolean;
  onFocusChange: (menuFocused: boolean) => void;
  onResolve: (answer: string) => void;
}

function actionItems(
  issue: RecoveryIssue,
  briefFinished: boolean,
  reviewNone: boolean,
): ActionItem[] {
  return getRecoveryPromptActions(issue).map((action) => ({
    action,
    key: recoveryActionKey(action),
    parts: recoveryMenuParts(action, issue, briefFinished, reviewNone),
  }));
}

function RecoveryActionRow({
  item,
  selected,
  recommended,
  width,
  keyWidth,
  keysLive,
}: {
  item: ActionItem;
  selected: boolean;
  recommended: boolean;
  width: number;
  keyWidth: number;
  keysLive: boolean;
}) {
  const t = useTheme();
  return (
    <ListRow
      label={item.parts.map((part) => part.text).join('')}
      labelParts={item.parts.map((part) => ({
        text: part.text,
        color: colorForTone(selected && part.tone === 'text' ? 'accent' : part.tone, t),
      }))}
      state={selected ? 'active' : 'default'}
      accelerator={keysLive ? item.key : ''}
      acceleratorWidth={keyWidth}
      metadata={recommended ? 'recommended' : undefined}
      metadataAfterLabel
      keepWhole="label"
      width={width}
    />
  );
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
  const actions = actionItems(issue, briefFinished, reviewNone);
  const recommended = recommendedRecoveryAction(issue);
  const keyWidth = actions.reduce((width, item) => Math.max(width, item.key.length), 0);
  const initialAction = Math.max(
    0,
    actions.findIndex((item) => item.action === recommended),
  );
  const fit = fitRecoveryMenu({ issue, width, boxRows: clampedBoxRows });

  // Every action resolves the prompt, `switch-seat` included: the driver answers it by opening
  // the seat's own picker on the offered tool, which is the one place a seat's tool and model are
  // chosen. A tool list here would be a second home for that choice, and a model-less one.
  const chooseAction = (item: ActionItem): void => {
    onResolve(recoveryActionKey(item.action));
  };
  const selectedIndex = useInlineMenuKeys({
    items: actions,
    keyOf: (item) => item.action,
    letterOf: (item) => item.key,
    initialIndex: initialAction,
    focused,
    listRows: fit.listRows,
    onSelect: chooseAction,
    onTab: () => {
      if (!slashHandoffPending()) onFocusChange(false);
    },
  });

  // Tab hands the keys to the composer, where a letter is a typed letter, so the panel stops
  // advertising its keys until focus comes back and says what ⏎ there does instead.
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
        <ActionList
          actions={actions}
          selectedIndex={selectedIndex}
          recommended={recommended}
          keyWidth={keyWidth}
          width={fit.innerWidth}
          rowBudget={fit.listRows}
          focused={focused}
        />
      </Box>
    </InlineMenuPanel>
  );
}

function ActionList({
  actions,
  selectedIndex,
  recommended,
  keyWidth,
  width,
  rowBudget,
  focused,
}: {
  actions: ActionItem[];
  selectedIndex: number;
  recommended: RecoveryAction | undefined;
  keyWidth: number;
  width: number;
  rowBudget: number;
  focused: boolean;
}) {
  return (
    <ListViewport
      items={actions}
      selectedIndex={selectedIndex}
      getKey={(item) => item.action}
      rowBudget={rowBudget}
      width={width}
      renderItem={(item, ctx) => (
        <RecoveryActionRow
          item={item}
          selected={ctx.isCursor && focused}
          recommended={item.action === recommended}
          width={ctx.contentWidth}
          keyWidth={keyWidth}
          keysLive={focused}
        />
      )}
    />
  );
}

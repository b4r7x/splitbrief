import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box, useInput } from 'ink';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { ListRow } from '../../../components/list-row.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { colorForTone } from '../../../core/theme/tone-color.js';
import { ListViewport } from '../../../components/pickers/list-viewport.js';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { slashHandoffPending } from '../slash-handoff.js';
import { formatKeyHints, SELECT_HINT } from '../prompt-rows/approval.js';
import { PromptBody } from './prompt-body.js';
import {
  correctionActionFor,
  recoveryPromptSummaryRows,
  getRecoveryPromptActions,
  recoveryActionKey,
  recoveryMenuActionLabel,
  recoveryMenuParts,
  recommendedRecoveryAction,
} from '../recovery-prompt.js';
import { countPromptBodyRows } from '../prompt-body-rows.js';
import { isCommandDraft } from '../../../core/composer/submission.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';

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

function actionItems(issue: RecoveryIssue): ActionItem[] {
  return getRecoveryPromptActions(issue).map((action) => ({
    action,
    key: recoveryActionKey(action),
    parts: recoveryMenuParts(action, issue),
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
  const actions = actionItems(issue);
  const recommended = recommendedRecoveryAction(issue);
  const keyWidth = actions.reduce((width, item) => Math.max(width, item.key.length), 0);
  const initialAction = Math.max(
    0,
    actions.findIndex((item) => item.action === recommended),
  );
  const innerWidth = Math.max(1, width - 4);
  const summary = recoveryPromptSummaryRows(issue, innerWidth);
  const summaryRows = countPromptBodyRows(summary, innerWidth);
  const minimumListRows = Math.min(4, Math.max(actions.length, 1));
  // A short panel keeps its content before its chrome: the headline (it carries the cut mark when
  // it is the only summary row), the selected action with one mark row that names every side
  // hiding actions, and the legend. Then the border, a second summary row for the mark, the other
  // actions, and the divider, in that order.
  const listFloor = Math.min(2, minimumListRows);
  const framed = clampedBoxRows >= 1 + listFloor + 1 + 2;
  const innerHeight = Math.max(1, clampedBoxRows - (framed ? 2 : 0));
  const besideList = innerHeight - listFloor - 1;
  const summaryHeight = Math.min(
    Math.max(1, summaryRows),
    Math.max(1, Math.min(2, besideList), innerHeight - minimumListRows - 2),
  );
  const divided = innerHeight - summaryHeight - minimumListRows - 1 > 0;
  const listBudget = Math.max(1, innerHeight - summaryHeight - 1 - (divided ? 1 : 0));

  // Every action resolves the prompt, `switch-seat` included: the driver answers it by opening
  // the seat's own picker on the offered tool, which is the one place a seat's tool and model are
  // chosen. A tool list here would be a second home for that choice, and a model-less one.
  const chooseAction = (item: ActionItem): void => {
    onResolve(recoveryActionKey(item.action));
  };
  const actionSelection = useStaticSelector({
    items: actions,
    initialIndex: initialAction,
    isActive: focused,
    keyOf: (item) => item.action,
    shouldHandleInput: () => !slashHandoffPending(),
    onSelect: chooseAction,
  });

  useInput(
    (input, key) => {
      if (slashHandoffPending()) return;
      // A letter is the row's own key; one that matches no offered row does nothing.
      if (input.length === 1 && !key.ctrl && !key.meta) {
        const letter = input.toLowerCase();
        const item = actions.find((entry) => recoveryActionKey(entry.action) === letter);
        if (item !== undefined) chooseAction(item);
        return;
      }
      if (key.tab || (key.shift && key.tab)) {
        onFocusChange(false);
      }
    },
    { isActive: focused },
  );

  // Tab hands the keys to the composer, where a letter is a typed letter, so the panel stops
  // advertising its keys until focus comes back and says what ⏎ there does instead.
  const correctionAction = correctionActionFor(issue);
  const commandDraft = composerLiveStore.use((draft) => isCommandDraft(draft.document));
  const composerEmpty = composerLiveStore.use((draft) => draft.empty);
  const composerLegend = commandDraft
    ? '⏎ runs the command'
    : correctionAction === undefined
      ? 'typing goes to the composer'
      : `⏎ ${recoveryMenuActionLabel(correctionAction, issue)} with the typed correction`;
  const legend = fitKeyLegend(
    focused
      ? formatKeyHints([
          SELECT_HINT,
          { key: '⏎', verb: 'confirm' },
          ...(correctionAction !== undefined
            ? [{ key: 'tab', verb: 'type a correction' }]
            : composerEmpty
              ? []
              : [{ key: 'tab', verb: 'edit the words' }]),
        ])
      : `${composerLegend}${SOFT_SEP}tab back to the actions`,
    innerWidth,
  );
  return (
    <Box
      flexDirection="column"
      width={width}
      height={Math.max(2, clampedBoxRows)}
      {...(framed && {
        borderStyle: borderStyleFor('single'),
        borderColor: focused ? t.accent : t.border,
        borderDimColor: !focused,
      })}
      paddingX={framed ? 1 : 2}
      overflow="hidden"
      flexShrink={0}
    >
      <PromptBody prompt={summary} height={summaryHeight} width={innerWidth} />
      {divided && <Text color={t.border}>{'─'.repeat(Math.max(1, innerWidth))}</Text>}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <ActionList
          actions={actions}
          selectedIndex={actionSelection.selectedIndex}
          recommended={recommended}
          keyWidth={keyWidth}
          width={innerWidth}
          rowBudget={listBudget}
          focused={focused}
        />
      </Box>
      <Text color={t.textDim} wrap="truncate-end">
        {legend}
      </Text>
    </Box>
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

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue, SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import { formatSeatCandidateIdentity } from '../../../core/crew/identity.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { useTheme } from '../../../components/theme.js';
import { ListRow } from '../../../components/list-row.js';
import { ListViewport } from '../../../components/pickers/list-viewport.js';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { PromptBody } from './prompt-body.js';
import {
  formatRecoveryPromptSummary,
  getRecoveryPromptActions,
  recoveryActionKey,
  recoveryActionLabel,
  recommendedRecoveryAction,
} from '../recovery-prompt.js';
import { countPromptBodyRows } from '../prompt-body-rows.js';

type RecoveryMenuView = 'actions' | 'tools';

interface ActionItem {
  action: RecoveryAction;
  label: string;
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
    label: recoveryActionLabel(action, {
      reason: issue.reason,
      facts: issue.facts,
      switchSeat: issue.switchSeat,
    }),
  }));
}

// The keys are the only instructions the panel gives, so a legend wider than the panel drops the
// clause it can spare whole — truncation would cut the last key, which is the way out, in half.
const LEGEND_SPARE_INDEX = 2;

function fitLegend(clauses: readonly string[], width: number): string {
  const full = clauses.join(SOFT_SEP);
  if (getTerminalCellWidth(full) <= width) return full;
  return clauses.filter((_, index) => index !== LEGEND_SPARE_INDEX).join(SOFT_SEP);
}

function renderAction(item: ActionItem, selected: boolean, recommended: boolean, width: number) {
  return (
    <ListRow
      label={item.label}
      width={width}
      state={selected ? 'active' : 'default'}
      metadata={recommended ? 'recommended' : undefined}
    />
  );
}

function renderCandidate(
  candidate: SeatSwapCandidate,
  selected: boolean,
  width: number,
  issue: RecoveryIssue,
) {
  const location =
    issue.taskId === undefined
      ? `${issue.seat === undefined ? 'current' : issue.seat.toUpperCase()} step`
      : 'this brief';
  return (
    <ListRow
      label={formatSeatCandidateIdentity(candidate)}
      width={width}
      state={selected ? 'active' : 'default'}
      metadata={`restarts ${location} · edits kept`}
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
  const [view, setView] = useState<RecoveryMenuView>('actions');
  const actions = actionItems(issue);
  const candidates = issue.switchSeat?.candidates ?? [];
  const recommended = recommendedRecoveryAction(issue);
  const initialAction = Math.max(
    0,
    actions.findIndex((item) => item.action === recommended),
  );
  const innerWidth = Math.max(1, width - 4);
  const innerHeight = Math.max(1, clampedBoxRows - 2);
  const summaryRows = countPromptBodyRows(formatRecoveryPromptSummary(issue), innerWidth);
  const minimumListRows = Math.min(4, Math.max(actions.length, candidates.length, 1));
  const summaryHeight = Math.min(
    Math.max(1, summaryRows),
    Math.max(1, innerHeight - minimumListRows - 2),
  );
  const listBudget = Math.max(1, innerHeight - summaryHeight - 2);

  const chooseAction = (item: ActionItem): void => {
    if (item.action === 'switch-seat' && candidates.length > 0) {
      setView('tools');
      return;
    }
    onResolve(recoveryActionKey(item.action));
  };
  const actionSelection = useStaticSelector({
    items: actions,
    initialIndex: initialAction,
    isActive: focused && view === 'actions',
    keyOf: (item) => item.action,
    onSelect: chooseAction,
  });
  const candidateSelection = useStaticSelector({
    items: candidates,
    isActive: focused && view === 'tools',
    keyOf: (candidate) => `${candidate.tool}:${candidate.model ?? ''}`,
    onSelect: (_candidate, index) => onResolve(index === 0 ? 'w' : `w${index + 1}`),
    onCancel: () => setView('actions'),
  });

  useInput(
    (input, key) => {
      if (
        view === 'actions' &&
        input === ' ' &&
        actions.some((item) => item.action === 'pause-run')
      ) {
        onResolve('space');
        return;
      }
      // A letter is the row's own key; one that matches no offered row does nothing.
      if (view === 'actions' && input.length === 1 && !key.ctrl && !key.meta) {
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

  const legend = fitLegend(
    view === 'tools'
      ? ['↑↓ select', '⏎ choose', 'esc back', 'tab type a reply']
      : ['↑↓ select', '⏎ choose', 'letter key acts', 'tab type a reply'],
    innerWidth,
  );
  return (
    <Box
      flexDirection="column"
      width={width}
      height={Math.max(2, clampedBoxRows)}
      borderStyle={borderStyleFor('single')}
      borderColor={focused ? t.accent : t.border}
      borderDimColor={!focused}
      paddingX={1}
      overflow="hidden"
      flexShrink={0}
    >
      <PromptBody
        prompt={formatRecoveryPromptSummary(issue)}
        height={summaryHeight}
        width={innerWidth}
      />
      {innerHeight > summaryHeight && (
        <Text color={t.border}>{'─'.repeat(Math.max(1, innerWidth))}</Text>
      )}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {view === 'tools' ? (
          <ToolList
            candidates={candidates}
            selectedIndex={candidateSelection.selectedIndex}
            width={innerWidth}
            rowBudget={listBudget}
            focused={focused}
            issue={issue}
          />
        ) : (
          <ActionList
            actions={actions}
            selectedIndex={actionSelection.selectedIndex}
            recommended={recommended}
            width={innerWidth}
            rowBudget={listBudget}
            focused={focused}
          />
        )}
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
  width,
  rowBudget,
  focused,
}: {
  actions: ActionItem[];
  selectedIndex: number;
  recommended: RecoveryAction | undefined;
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
      renderItem={(item, ctx) =>
        renderAction(item, ctx.isCursor && focused, item.action === recommended, ctx.contentWidth)
      }
    />
  );
}

function ToolList({
  candidates,
  selectedIndex,
  width,
  rowBudget,
  focused,
  issue,
}: {
  candidates: SeatSwapCandidate[];
  selectedIndex: number;
  width: number;
  rowBudget: number;
  focused: boolean;
  issue: RecoveryIssue;
}) {
  return (
    <ListViewport
      items={candidates}
      selectedIndex={selectedIndex}
      getKey={(candidate) => `${candidate.tool}:${candidate.model ?? ''}`}
      rowBudget={rowBudget}
      width={width}
      renderItem={(candidate, ctx) =>
        renderCandidate(candidate, ctx.isCursor && focused, ctx.contentWidth, issue)
      }
    />
  );
}

import { Box } from 'ink';
import type { RuntimeCommandDef } from '../../../core/runtime/commands/types.js';
import type { InputMode } from '../../../core/navigation/types.js';
import { Composer, type ComposerBoxHints } from '../../../components/composer/composer.js';
import { Header } from './header.js';
import { FeedbackRow } from './feedback-row.js';
import { InputFooter } from './input-footer.js';
import { Divider } from './divider.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { formatCostDisplay } from '../cost-text.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import { glyph } from '../../../lib/glyphs.js';
import type { ComposerBoxHintOverride } from '../input-hints.js';
import type { RailForm } from '../layout/chrome-rows.js';
import type { WorkflowReviewColumn } from '../layout/rect.js';

// The composer no longer advertises the ⏎ submit hint; the keys slot carries only override hints
// (cancelled/attach bylines) and the completion check mark.
function useComposerBoxHints(override?: ComposerBoxHintOverride | undefined): ComposerBoxHints {
  const complete = lifecycleStore.use((s) => s.phase === 'complete');
  const { localRate, costBreakdown, pricingState } = useCostStats();
  const baseKeys = override ? override.keys : '';
  const keys = complete
    ? [baseKeys, glyph('check')].filter((part) => part.length > 0).join('  ')
    : baseKeys;
  const display = formatCostDisplay(localRate, costBreakdown, pricingState);
  const cost = override?.cost === true && display.hasPricedUsage ? display.spentText : undefined;
  return { keys, cost };
}

export function WorkflowHeader({
  startedAt,
  scrollAboveLabel = '',
  railForm,
}: {
  startedAt: string;
  scrollAboveLabel?: string;
  railForm?: RailForm | undefined;
}) {
  const cols = terminalSizeStore.use((s) => s.cols);
  return (
    <>
      <Header startedAt={startedAt} railForm={railForm} />
      <Divider width={cols} label={scrollAboveLabel} tone="textDim" />
    </>
  );
}

export function WorkflowFooter({
  handleInput,
  onEmptySubmit,
  onRuntimeCommand,
  commands,
  mode,
  inputHint,
  feedbackHint,
  boxHintOverride,
  disabled,
  onEditShortcut,
  reviewColumn,
  questionEpoch,
  waitingForUser = false,
}: {
  handleInput: (text: string) => void;
  onEmptySubmit?: (() => void) | undefined;
  onRuntimeCommand: (command: string) => void;
  commands: RuntimeCommandDef[];
  mode: InputMode;
  inputHint: string;
  feedbackHint?: string | undefined;
  boxHintOverride?: ComposerBoxHintOverride | undefined;
  disabled: boolean;
  onEditShortcut?: (() => void) | undefined;
  reviewColumn?: WorkflowReviewColumn | undefined;
  questionEpoch?: number | undefined;
  waitingForUser?: boolean | undefined;
}) {
  const composerWidthProps = reviewColumn
    ? { width: reviewColumn.width, boxLeftOffset: reviewColumn.leftOffset }
    : {};
  const footerWidthProps = reviewColumn ? { width: reviewColumn.width } : {};
  const boxHints = useComposerBoxHints(boxHintOverride);
  const footer = (
    <>
      <FeedbackRow inputHint={feedbackHint ?? inputHint} />
      <Composer
        onSubmit={handleInput}
        onEmptySubmit={onEmptySubmit}
        onRuntimeCommand={onRuntimeCommand}
        commands={commands}
        mode={mode}
        hint={inputHint}
        currentScreen="workflow"
        disabled={disabled}
        boxHints={boxHints}
        questionEpoch={questionEpoch}
        inputPaddingX={0}
        {...composerWidthProps}
        {...(onEditShortcut ? { onEditShortcut } : {})}
      />
      <InputFooter {...footerWidthProps} waiting={waitingForUser} />
    </>
  );

  if (mode !== 'review' || reviewColumn === undefined) return footer;

  return (
    <Box width="100%" flexDirection="column" flexShrink={0}>
      <Box
        flexDirection="column"
        marginLeft={reviewColumn.leftOffset}
        width={reviewColumn.width}
        overflow="hidden"
      >
        {footer}
      </Box>
    </Box>
  );
}

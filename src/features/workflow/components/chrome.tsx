import type { RuntimeCommandDef } from '../../../core/runtime/commands/types.js';
import type { InputMode } from '../../../core/navigation/types.js';
import { Composer, type ComposerBoxHints } from '../../../components/composer/composer.js';
import { Header } from './header.js';
import { FeedbackRow } from './feedback-row.js';
import { InputFooter } from './input-footer.js';
import { Divider } from './divider.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useFieldSessionOwned } from '../../editor/use-field-session-owned.js';
import { formatCostDisplay } from '../cost-text.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import { glyph } from '../../../lib/glyphs.js';
import type { ComposerBoxHintOverride } from '../input-hints.js';
import type { RailForm } from '../layout/chrome-rows.js';

function useComposerBoxHints(override?: ComposerBoxHintOverride | undefined): ComposerBoxHints {
  const complete = lifecycleStore.use((s) => s.phase === 'complete');
  const { localRate, costBreakdown, pricingState } = useCostStats();
  const baseKeys = override?.keys ?? '';
  const keys = complete
    ? [baseKeys, glyph('check')].filter((part) => part.length > 0).join('  ')
    : baseKeys;
  const display = formatCostDisplay(localRate, costBreakdown, pricingState);
  const cost = override?.cost && display.showSpend ? display.spentText : undefined;
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
  onReviewBoundaryNavigate,
  onReviewInteraction,
  reviewYankActive,
  reviewEpoch,
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
  onReviewBoundaryNavigate?: ((direction: 'up' | 'down') => boolean | undefined) | undefined;
  onReviewInteraction?: (() => void) | undefined;
  reviewYankActive?: boolean | undefined;
  reviewEpoch?: number | undefined;
  questionEpoch?: number | undefined;
  waitingForUser?: boolean | undefined;
}) {
  const boxHints = useComposerBoxHints(boxHintOverride);
  const fieldEditorOpen = useFieldSessionOwned();
  const composerSession = mode === 'review' ? `review:${reviewEpoch ?? 0}` : 'non-review';
  const footer = (
    <>
      <FeedbackRow inputHint={feedbackHint ?? inputHint} />
      <Composer
        key={composerSession}
        onSubmit={handleInput}
        onEmptySubmit={onEmptySubmit}
        onRuntimeCommand={onRuntimeCommand}
        commands={commands}
        mode={mode}
        hint={inputHint}
        currentScreen="workflow"
        disabled={disabled || fieldEditorOpen}
        boxHints={boxHints}
        questionEpoch={questionEpoch}
        inputPaddingX={0}
        {...(onEditShortcut ? { onEditShortcut } : {})}
        {...(onReviewBoundaryNavigate ? { onReviewBoundaryNavigate } : {})}
        {...(onReviewInteraction ? { onReviewInteraction } : {})}
        reviewYankActive={reviewYankActive}
      />
      <InputFooter waiting={waitingForUser} />
    </>
  );
  return footer;
}

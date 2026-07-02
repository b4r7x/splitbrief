import { useState } from 'react';
import { Box } from 'ink';
import type {
  RuntimeCommandDef,
  CopyResult,
  CopyTarget,
} from '../../core/runtime/commands/types.js';
import type { Focus } from '../../stores/ui/focus.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { CostApprovalPromptConnected } from '../../features/workflow/components/cost-approval-prompt.js';
import { QuestionPrompt } from '../../features/workflow/components/question-prompt.js';
import { ReadinessPanel } from '../../features/workflow/components/readiness-panel.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { useTheme } from '../../components/theme.js';
import { Divider } from '../../features/workflow/components/divider.js';
import { Spinner } from '../../features/workflow/components/spinner.js';
import { WorkflowBody } from '../../features/workflow/components/body.js';
import { WorkflowFooter, WorkflowHeader } from '../../features/workflow/components/chrome.js';
import {
  useWorkflowScreen,
  type WorkflowScreenDeps,
} from '../../features/workflow/hooks/use-workflow-screen.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { useStores } from '../../stores/use-stores.js';
import {
  clampWorkflowPromptRows,
  getWorkflowContentWidth,
  getWorkflowReviewColumn,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
} from '../../features/workflow/layout/rect.js';
import { selectRailForm } from '../../features/workflow/layout/chrome-rows.js';
import { getWorkflowPromptRows } from '../../features/workflow/prompt-rows.js';

interface WorkflowScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
  copyTarget?: ((target: CopyTarget) => Promise<CopyResult>) | undefined;
  canCopyFocused?: ((focus: Focus | null) => boolean) | undefined;
  deps?: WorkflowScreenDeps | undefined;
}

export function WorkflowScreen({
  commands,
  onRuntimeCommand,
  copyTarget,
  canCopyFocused,
  deps,
}: WorkflowScreenProps) {
  const t = useTheme();
  const [input, terminal] = useStores(inputHeightStore, terminalSizeStore);
  const { cols, rows, isSmall } = terminal;
  const inputRows = input.rows;
  const sidebarVisible = controlsStore.use((s) => s.sidebarVisible);
  const [scrollAboveLabel, setScrollAboveLabel] = useState('');
  const [scrollBelowLabel, setScrollBelowLabel] = useState('');

  const model = useWorkflowScreen({ onRuntimeCommand, copyTarget, canCopyFocused, deps });

  const sidebarWidth = getWorkflowSidebarWidth({
    cols,
    sidebarVisible,
    isSmall,
  });
  const showSidebar = sidebarWidth > 0;
  const questionHint = model.inputMode.mode === 'question' ? model.inputMode.hint : null;
  const railForm = selectRailForm({ phase: model.phase, cols });
  const promptRows = clampWorkflowPromptRows({
    rows,
    inputRows,
    promptRows: getWorkflowPromptRows({
      approvalState: model.approvalPromptState,
      costApprovalState: model.costApprovalState,
      questionHint,
      cols,
    }),
  });
  const promptBoxRows = model.promptPending ? Math.max(1, promptRows) : promptRows;
  const contentHeight = getWorkflowViewportHeight({
    rows,
    inputRows,
    promptRows: promptBoxRows,
  });
  const contentWidth = getWorkflowContentWidth({
    cols,
    sidebarVisible,
    isSmall,
  });
  const reviewColumn =
    model.inputMode.mode === 'review'
      ? getWorkflowReviewColumn({ cols, sidebarVisible, isSmall })
      : undefined;

  if (!model.readinessLoaded) {
    return (
      <ScreenShell>
        <Box paddingX={2}>
          <Spinner label="checking readiness…" color={t.textDim} />
        </Box>
      </ScreenShell>
    );
  }

  if (model.readinessBlocked && model.readiness !== undefined) {
    return <ReadinessPanel report={model.readiness} onOpenFix={model.onOpenReadinessFix} />;
  }

  return (
    <ScreenShell
      header={
        <WorkflowHeader
          startedAt={model.startedAt}
          scrollAboveLabel={scrollAboveLabel}
          railForm={railForm}
        />
      }
      footer={
        <>
          <Divider width={cols} tone="textDim" label={scrollBelowLabel} />
          <WorkflowFooter
            handleInput={model.handleInput}
            onEmptySubmit={model.onEmptySubmit}
            onRuntimeCommand={model.handleRuntimeCommand}
            commands={commands}
            mode={model.inputMode.mode}
            inputHint={model.inputHint}
            questionEpoch={model.questionEpoch}
            feedbackHint={model.feedbackHint}
            boxHintOverride={model.boxHintOverride}
            reviewColumn={reviewColumn}
            waitingForUser={
              model.inputMode.mode !== 'normal' || model.approvalPending || model.costPending
            }
            {...(model.onEditShortcut ? { onEditShortcut: model.onEditShortcut } : {})}
            disabled={
              model.hasOverlay ||
              model.promptPending ||
              (model.isAttachedClient && !model.ipcConnected)
            }
          />
        </>
      }
    >
      <WorkflowBody
        showSidebar={showSidebar}
        sidebarWidth={sidebarWidth}
        inputMode={model.inputMode}
        reviewFilePath={model.reviewFilePath}
        phase={model.phase}
        contentHeight={contentHeight}
        contentWidth={contentWidth}
        onScrollAbove={setScrollAboveLabel}
        onScrollBelow={setScrollBelowLabel}
      />
      <Box height={promptBoxRows} overflow="hidden" flexDirection="column" flexShrink={0}>
        {model.approvalPending && <ApprovalPrompt clampedBoxRows={promptBoxRows} />}
        {model.costPending && <CostApprovalPromptConnected clampedBoxRows={promptBoxRows} />}
        {model.inputMode.mode === 'question' && (
          <QuestionPrompt hint={model.inputMode.hint} width={cols} clampedBoxRows={promptBoxRows} />
        )}
      </Box>
    </ScreenShell>
  );
}

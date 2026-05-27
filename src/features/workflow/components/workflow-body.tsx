import { Box } from 'ink';
import { dirname } from 'node:path';
import { ConversationFlow } from './conversation-flow/flow.js';
import { Sidebar } from './sidebar.js';
import { BriefReviewView } from './brief-review-view.js';
import { PlanEditorComponent } from './plan-editor.js';
import { ReviewView } from './review-view.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import { buildTargetedRejectionComment } from '../../../engine/orchestrator/planning/regen-targeted.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { Section } from '../../../core/layout/event-sections.js';
import type { Phase } from '../../../core/schemas/enums.js';

export function WorkflowBody({
  showSidebar,
  sidebarWidth,
  inputMode,
  reviewFilePath,
  phase,
  useRichEditor,
  contentHeight,
  contentWidth,
  sections,
}: {
  showSidebar: boolean;
  sidebarWidth: number;
  inputMode: UseInputModeResult;
  reviewFilePath: string | null | undefined;
  phase: Phase;
  useRichEditor: boolean;
  contentHeight: number;
  contentWidth: number;
  sections: Section<EngineEvent>[];
}) {
  return (
    <Box flexDirection="row" flexGrow={1}>
      {showSidebar && (
        <Sidebar width={sidebarWidth} />
      )}
      {inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' && useRichEditor ? (
        <PlanEditorComponent
          filePath={reviewFilePath}
          height={contentHeight}
          width={contentWidth}
          sessionDirPath={dirname(reviewFilePath)}
          onApprove={() => inputMode.resolve({ approved: true })}
          onRegenerateFlagged={async () => {
            const flagged = planEditorStore.getFlaggedTasks();
            if (flagged.length === 0) return;
            const comment = buildTargetedRejectionComment(flagged);
            planEditorStore.clearFlags();
            inputMode.resolve({ approved: true, comment });
          }}
        />
      ) : inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' ? (
        <BriefReviewView filePath={reviewFilePath} height={contentHeight} width={contentWidth} />
      ) : inputMode.mode === 'review' && reviewFilePath ? (
        <ReviewView height={contentHeight} width={contentWidth} />
      ) : (
        <ConversationFlow sections={sections} height={contentHeight} width={contentWidth} />
      )}
    </Box>
  );
}

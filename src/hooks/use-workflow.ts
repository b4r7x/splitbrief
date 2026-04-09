import type { Config, Summary, WorkflowState, SkillMeta } from '../types.js';
import { useInputMode } from './use-input-mode.js';
import { useWorkflowRunner } from './use-workflow-runner.js';
import { useWorkflowReviewInput } from './use-workflow-review-input.js';

interface UseWorkflowOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  initialResumeState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
}

export function useWorkflow(opts: UseWorkflowOptions) {
  const inputMode = useInputMode();
  const runner = useWorkflowRunner({ ...opts, inputMode });
  const { handleInput } = useWorkflowReviewInput({ inputMode });

  return {
    startedAt: runner.startedAt,
    handleResume: runner.handleResume,
    handleInput,
    inputMode: inputMode.mode,
    inputHint: inputMode.hint,
  };
}

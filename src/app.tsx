import { useState, useEffect } from 'react';
import Layout from './tui/layout.js';
import SummaryView from './tui/summary.js';
import QuestionPrompt from './tui/question-prompt.js';
import UserInput from './tui/user-input.js';
import { runWorkflow, calculateCostBreakdown } from './orchestrator/orchestrator.js';
import { loadConfig } from './config.js';
import type { Phase, Task, Summary, OrchestratorCallbacks, ValidationResult, WorkflowState } from './types.js';
import type { ClarificationQuestion } from './orchestrator/question-parser.js';

interface AppProps {
  feature: string;
  projectDir: string;
  auto: boolean;
  modelOverride?: string;
  providerOverride?: string;
  contextLengthOverride?: number;
  plannerOverride?: string;
  plannerModelOverride?: string;
  savedState?: WorkflowState;
}

export default function App({ feature, projectDir, auto, modelOverride, providerOverride, contextLengthOverride, plannerOverride, plannerModelOverride, savedState }: AppProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [plannerLines, setPlannerLines] = useState<string[]>([]);
  const [implementerLines, setImplementerLines] = useState<string[]>([]);
  const [currentTask, setCurrentTask] = useState(0);
  const [totalTasks, setTotalTasks] = useState(0);
  const [retries, setRetries] = useState(0);
  const [model, setModel] = useState('');
  const [approval, setApproval] = useState<{
    type: 'spec' | 'plan';
    filePath: string;
    onApprove: () => void;
    onReject: () => void;
    onComment?: (text: string) => void;
    supportsSession?: boolean;
  } | null>(null);
  const [startedAt, setStartedAt] = useState('');
  const [screen, setScreen] = useState<'workflow' | 'summary'>('workflow');
  const [summaryData, setSummaryData] = useState<Summary | null>(null);
  const [inputMode, setInputMode] = useState<{
    type: 'question';
    question: ClarificationQuestion;
    questionNumber: number;
    totalQuestions: number;
    onResolve: (answer: string) => void;
  } | {
    type: 'comment';
    prompt: string;
    onResolve: (text: string) => void;
  } | null>(null);

  const MAX_LINES = 10_000;
  const appendLines = (setter: typeof setPlannerLines) => (text: string) => {
    setter(prev => {
      const next = [...prev, text];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  };

  async function askQuestion(question: ClarificationQuestion, num: number, total: number): Promise<string> {
    if (auto) return question.default?.toString() ?? '';
    return new Promise<string>((resolve) => {
      setInputMode({
        type: 'question',
        question,
        questionNumber: num,
        totalQuestions: total,
        onResolve: (answer: string) => {
          setInputMode(null);
          resolve(answer);
        },
      });
    });
  }

  useEffect(() => {
    const config = loadConfig(projectDir);

    if (modelOverride) config.implementer.model = modelOverride;
    if (providerOverride) config.implementer.provider = providerOverride as typeof config.implementer.provider;
    if (contextLengthOverride) config.implementer.contextLength = contextLengthOverride;
    if (plannerOverride) (config.planner as any).tool = plannerOverride;
    if (plannerModelOverride) (config.planner as any).model = plannerModelOverride;

    setModel(config.implementer.model);
    setStartedAt(new Date().toISOString());

    const callbacks: OrchestratorCallbacks = {
      onPhaseChange(p: Phase) {
        setPhase(p);
      },
      onPlannerOutput: appendLines(setPlannerLines),
      onImplementerOutput: appendLines(setImplementerLines),
      onTaskStart(task: Task, index: number, total: number) {
        setCurrentTask(index + 1);
        setTotalTasks(total);
      },
      onTaskRetry(_task: Task, attempt: number, _error: string) {
        setRetries(attempt);
      },
      onTaskComplete(_task: Task, _method: 'local' | 'escalated') {
        setRetries(0);
      },
      onTaskSkipped(_task: Task, _reason: string) {},
      onValidationResult(_task: Task, _results: ValidationResult[]) {},
      onApprovalNeeded(type: 'spec' | 'plan', filePath: string): Promise<{ approved: boolean; comment?: string }> {
        if (auto) return Promise.resolve({ approved: true });
        const sessionPlanners = ['claude-code', 'agent-sdk'];
        const supportsSession = sessionPlanners.includes(config.planner.tool);
        return new Promise<{ approved: boolean; comment?: string }>(resolve => {
          setApproval({
            type,
            filePath,
            supportsSession,
            onApprove() {
              setApproval(null);
              resolve({ approved: true });
            },
            onReject() {
              setApproval(null);
              resolve({ approved: false });
            },
            onComment(text: string) {
              setApproval(null);
              resolve({ approved: false, comment: text });
            },
          });
        });
      },
      onExternalChanges(): Promise<boolean> {
        if (auto) return Promise.resolve(true);
        return new Promise<boolean>(resolve => {
          setApproval({
            type: 'plan',
            filePath: '',
            onApprove() {
              setApproval(null);
              resolve(true);
            },
            onReject() {
              setApproval(null);
              resolve(false);
            },
          });
        });
      },
      onComplete(summary: Summary) {
        const costBreakdown = calculateCostBreakdown(
          summary.tokenUsage,
          summary.totalTasks,
          summary.escalatedToPlanner,
          config.planner.tool,
          config.implementer.provider,
        );
        setSummaryData({
          ...summary,
          costBreakdown,
          plannerName: config.planner.tool,
          implementerName: `${config.implementer.provider} / ${config.implementer.model}`,
        });
        setScreen('summary');
      },
      onQuestionAsked: askQuestion,
      onError: (error: string) => {
        appendLines(setPlannerLines)(`[ERROR] ${error}`);
        appendLines(setImplementerLines)(`[ERROR] ${error}`);
      },
    };

    runWorkflow(feature, projectDir, config, callbacks, savedState).catch(err => callbacks.onError(String(err)));
  }, []);

  if (screen === 'summary' && summaryData) {
    return <SummaryView summary={summaryData} />;
  }

  return (
    <>
      <Layout
        feature={feature}
        startedAt={startedAt}
        phase={phase}
        currentTask={currentTask}
        totalTasks={totalTasks}
        model={model}
        retries={retries}
        plannerLines={plannerLines}
        implementerLines={implementerLines}
        approval={approval}
      />
      {inputMode?.type === 'question' && (
        <QuestionPrompt
          question={inputMode.question}
          questionNumber={inputMode.questionNumber}
          totalQuestions={inputMode.totalQuestions}
          onAnswer={(questionId, answer) => inputMode.onResolve(answer)}
          onSkip={(_questionId) => inputMode.onResolve('skip')}
          onDone={() => inputMode.onResolve('done')}
        />
      )}
      {inputMode?.type === 'comment' && (
        <UserInput
          prompt={inputMode.prompt}
          onSubmit={(text) => inputMode.onResolve(text)}
        />
      )}
    </>
  );
}

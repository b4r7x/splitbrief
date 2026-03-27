import { useState, useEffect } from 'react';
import Layout from './tui/layout.js';
import SummaryView from './tui/summary.js';
import QuestionPrompt from './tui/question-prompt.js';
import UserInput from './tui/user-input.js';
import { runWorkflow, calculateCostBreakdown } from './orchestrator/orchestrator.js';
import { loadConfig } from './config.js';
import type { Phase, TuiEvent, Summary, OrchestratorCallbacks, WorkflowState } from './types.js';
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

const MAX_EVENTS = 10_000;

export default function App({ feature, projectDir, auto, modelOverride, providerOverride, contextLengthOverride, plannerOverride, plannerModelOverride, savedState }: AppProps) {
  const [events, setEvents] = useState<TuiEvent[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [currentTask, setCurrentTask] = useState(0);
  const [totalTasks, setTotalTasks] = useState(0);
  const [localCount, setLocalCount] = useState(0);
  const [escalatedCount, setEscalatedCount] = useState(0);
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

  const localRate = (localCount + escalatedCount) > 0
    ? (localCount / (localCount + escalatedCount)) * 100
    : 0;

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
      onEvent: (event: TuiEvent) => {
        setEvents(prev => {
          const next = [...prev, event];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });
        if (event.type === 'planner-status') setPhase(event.phase as Phase);
        if (event.type === 'task-start') { setCurrentTask(event.index + 1); setTotalTasks(event.total); }
        if (event.type === 'task-complete') {
          if (event.method === 'local') setLocalCount(prev => prev + 1);
          else setEscalatedCount(prev => prev + 1);
        }
      },
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
              callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: type === 'spec' ? 'reviewing-spec' : 'reviewing-plan', status: 'done', summary: 'Approved' });
              resolve({ approved: true });
            },
            onReject() {
              setApproval(null);
              resolve({ approved: false });
            },
            onComment(text: string) {
              setApproval(null);
              callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text: `Comment: ${text}` });
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
    };

    runWorkflow(feature, projectDir, config, callbacks, savedState).catch(err => {
      callbacks.onEvent({ type: 'error', ts: Date.now(), message: String(err) });
    });
  }, []);

  if (screen === 'summary' && summaryData) {
    return <SummaryView summary={summaryData} />;
  }

  const costBreakdown = (localCount + escalatedCount) > 0
    ? calculateCostBreakdown(
        { plannerInput: 0, plannerOutput: 0, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 },
        localCount + escalatedCount,
        escalatedCount,
      )
    : null;

  return (
    <Layout
      feature={feature}
      startedAt={startedAt}
      phase={phase}
      events={events}
      currentTask={currentTask}
      totalTasks={totalTasks}
      model={model}
      localRate={localRate}
      estimatedCost={costBreakdown?.totalActualCost ?? 0}
      estimatedSavings={costBreakdown?.savingsAmount ?? 0}
      approval={approval}
    >
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
    </Layout>
  );
}

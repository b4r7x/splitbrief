import { Box, Text } from 'ink';
import type { TuiEvent } from '../types.js';
import type { Theme } from '../ui/theme.js';
import { useTheme } from '../ui/theme.js';
import DiffView from '../ui/diff-view.js';
import { PlannerText } from '../ui/markdown.js';
import { Spinner } from '../ui/spinner.js';
import { Gutter } from './gutter.js';
import { formatDuration } from '../utils/format.js';
import { formatModelName } from '../utils/model-names.js';

interface EventCardProps {
  event: TuiEvent;
  diffExpanded?: boolean;
}

const IMPL_PHASES: ReadonlySet<string> = new Set(['implementing', 'validating-task']);

function phaseRole(phase: string): 'planner' | 'implementer' {
  if (IMPL_PHASES.has(phase)) return 'implementer';
  return 'planner';
}

function PlannerStatusCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'planner-status' }>; theme: Theme }) {
  const dur = event.duration ? ` ${formatDuration(event.duration)}` : '';
  const role = phaseRole(event.phase);
  const color = role === 'implementer' ? t.implementer : t.planner;

  if (event.status === 'done') {
    return (
      <Box>
        <Text color={color}>{role}</Text>
        <Text color={t.success}>  ✓ {event.phase}</Text>
        <Text color={t.textDim}>{dur}</Text>
        {event.summary && <Text color={t.textDim}>  {event.summary}</Text>}
      </Box>
    );
  }
  return <Spinner label={`${role}  ${event.phase}...`} color={color} startTime={event.ts} />;
}

function TaskStartCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'task-start' }>; theme: Theme }) {
  return (
    <Box marginTop={1}>
      <Text color={t.text} bold>T{event.index + 1}: {event.title}</Text>
      <Text color={t.textDim}>  {event.file} ({event.action})</Text>
    </Box>
  );
}

function ImplementerCard({ event, diffExpanded, theme: t }: { event: Extract<TuiEvent, { type: 'implementer-generate' }>; diffExpanded: boolean; theme: Theme }) {
  if (event.status === 'running') {
    const fileHint = event.file ? `generating ${event.file}...` : 'generating...';
    return <Spinner label={`${formatModelName(event.model ?? 'local')}  ${fileHint}`} color={t.implementer} startTime={event.ts} />;
  }

  const dur = event.duration ? formatDuration(event.duration) : '';

  if (event.status === 'failed') {
    return (
      <Box>
        <Text color={t.implementer}>{formatModelName(event.model ?? '?')}</Text>
        <Text color={t.error}>  failed</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.implementer}>{formatModelName(event.model ?? '?')}</Text>
        <Text color={t.textDim}>  {dur}</Text>
      </Box>
      {event.file && event.diff != null && event.linesAdded != null && event.linesRemoved != null ? (
        <DiffView
          file={event.file}
          linesAdded={event.linesAdded}
          linesRemoved={event.linesRemoved}
          diff={event.diff}
          expanded={diffExpanded}
        />
      ) : event.file ? (
        <Box>
          <Text color={t.textDim}>  {event.file} (+{event.linesAdded ?? 0} -{event.linesRemoved ?? 0})</Text>
        </Box>
      ) : null}
    </Box>
  );
}

const VALIDATION_STAGES = ['tsc', 'lint', 'test'] as const;

function stageIndicator(name: string, passed: boolean, failed: boolean, isCurrent: boolean, t: Theme) {
  if (passed) return <Box key={name}><Text color={t.textDim}>  {name} </Text><Text color={t.success}>✓</Text></Box>;
  if (failed) return <Box key={name}><Text color={t.textDim}>  {name} </Text><Text color={t.error}>✗</Text></Box>;
  if (isCurrent) return <Box key={name}><Text>  </Text></Box>;
  return <Box key={name}><Text color={t.textDim}>  {name} </Text><Text color={t.textDim}>○</Text></Box>;
}

function ValidateCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'validate' }>; theme: Theme }) {
  if (event.status === 'running') {
    const stages = event.stages;
    const currentStage = VALIDATION_STAGES.find(s => !stages[s]) ?? 'test';
    return (
      <Box>
        <Text color={t.validator}>validate</Text>
        {VALIDATION_STAGES.map(s => stageIndicator(s, stages[s], false, currentStage === s, t))}
        <Spinner label={currentStage} color={t.validator} startTime={event.ts} />
      </Box>
    );
  }

  const dur = event.duration ? `  ${formatDuration(event.duration)}` : '';

  if (event.passed) {
    return (
      <Box>
        <Text color={t.validator}>validate</Text>
        {VALIDATION_STAGES.map(s => stageIndicator(s, true, false, false, t))}
        <Text color={t.textDim}>{dur}</Text>
      </Box>
    );
  }

  const failedStage = VALIDATION_STAGES.find(s => !event.stages[s]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.validator}>validate</Text>
        {VALIDATION_STAGES.map(s => stageIndicator(s, event.stages[s], s === failedStage, false, t))}
        <Text color={t.textDim}>{dur}</Text>
      </Box>
      {event.error && (
        <Box marginLeft={2}>
          <Text color={t.error}>{event.error}</Text>
        </Box>
      )}
    </Box>
  );
}

function RetryCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'retry' }>; theme: Theme }) {
  return (
    <Box>
      <Text color={t.warning}>retry </Text>
      <Text color={t.textDim}>attempt {event.attempt}/{event.maxRetries}</Text>
    </Box>
  );
}

function EscalateCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'escalate' }>; theme: Theme }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.planner} bold>escalate </Text>
        <Text color={t.textDim}>tier {event.tier}</Text>
        {event.hint && <Text color={t.textDim}> — hint</Text>}
      </Box>
      {event.hint && (
        <Box marginLeft={2}>
          <Text color={t.textDim}>{event.hint}</Text>
        </Box>
      )}
    </Box>
  );
}

function GitCommitCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'git-commit' }>; theme: Theme }) {
  return (
    <Box>
      <Text color={t.success}>committed </Text>
      <Text color={t.textDim}>{event.message}</Text>
    </Box>
  );
}

function GitCheckpointCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'git-checkpoint' }>; theme: Theme }) {
  return (
    <Box>
      <Text color={t.success}>checkpoint </Text>
      <Text color={t.textDim}>{event.tag}</Text>
    </Box>
  );
}

function ErrorCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'error' }>; theme: Theme }) {
  return (
    <Box>
      <Text color={t.error}>error </Text>
      <Text color={t.error}>{event.message}</Text>
    </Box>
  );
}

function getGutterRole(event: TuiEvent): 'planner' | 'implementer' | null {
  switch (event.type) {
    case 'planner-status':
      return phaseRole(event.phase);
    case 'planner-text':
    case 'task-start':
      return 'planner';
    case 'implementer-generate':
    case 'validate':
    case 'git-commit':
    case 'git-checkpoint':
    case 'retry':
      return 'implementer';
    case 'escalate':
      return 'planner';
    case 'error':
    case 'task-complete':
    case 'task-skipped':
    // cost-update: intercepted by workflowStore.addEvent — kept for exhaustive type checking
    case 'cost-update':
    case 'workflow-cancelled':
      return null;
  }
}

function renderEventContent(event: TuiEvent, t: Theme, diffExpanded?: boolean): React.JSX.Element | null {
  switch (event.type) {
    case 'planner-status':
      return <PlannerStatusCard event={event} theme={t} />;
    case 'planner-text':
      return <PlannerText text={event.text} theme={t} />;
    case 'task-start':
      return <TaskStartCard event={event} theme={t} />;
    case 'task-complete':
      return null;
    case 'task-skipped':
      return (
        <Box>
          <Text color={t.textDim}>skipped T{event.taskId} {event.title}: {event.reason}</Text>
        </Box>
      );
    case 'implementer-generate':
      return <ImplementerCard event={event} diffExpanded={diffExpanded ?? false} theme={t} />;
    case 'validate':
      return <ValidateCard event={event} theme={t} />;
    case 'retry':
      return <RetryCard event={event} theme={t} />;
    case 'escalate':
      return <EscalateCard event={event} theme={t} />;
    case 'git-commit':
      return <GitCommitCard event={event} theme={t} />;
    case 'git-checkpoint':
      return <GitCheckpointCard event={event} theme={t} />;
    case 'error':
      return <ErrorCard event={event} theme={t} />;
    case 'workflow-cancelled':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.warning} bold>Workflow cancelled</Text>
          <Text color={t.textDim}>Resume with: <Text color={t.text}>tiny-spec resume</Text></Text>
        </Box>
      );
    // cost-update: intercepted by workflowStore.addEvent — kept for exhaustive type checking
    case 'cost-update':
      return null;
  }
}

export function renderEvent(event: TuiEvent, t: Theme, diffExpanded?: boolean): React.JSX.Element | null {
  const content = renderEventContent(event, t, diffExpanded);
  if (!content) return null;

  const role = getGutterRole(event);
  if (!role) return content;

  return <Gutter role={role}>{content}</Gutter>;
}

export default function EventCard({ event, diffExpanded }: EventCardProps) {
  const t = useTheme();
  return renderEvent(event, t, diffExpanded);
}

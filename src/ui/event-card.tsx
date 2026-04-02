import { Box, Text } from 'ink';
import type { TuiEvent } from '../types.js';
import type { Theme } from '../core/theme.js';
import { useAppContext } from '../app.js';
import DiffView from './diff-view.js';
import { PlannerText } from './markdown.js';
import { Spinner } from './spinner.js';
import { formatDuration } from '../utils/format.js';

interface EventCardProps {
  event: TuiEvent;
  diffExpanded?: boolean;
}

function PlannerStatusCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'planner-status' }>; theme: Theme }) {
  const dur = event.duration ? ` ${formatDuration(event.duration)}` : '';
  const statusText = event.status === 'done'
    ? `${event.phase} done${dur}`
    : `${event.phase}...`;

  return (
    <Box>
      <Text color={t.planner}>planner </Text>
      <Text color={t.text}>{statusText}</Text>
      {event.summary && <Text color={t.textDim}> {event.summary}</Text>}
    </Box>
  );
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
    return <Spinner label={`generating ${event.model ?? 'local'}...`} color={t.implementer} />;
  }

  const dur = event.duration ? `  ${formatDuration(event.duration)}` : '';

  if (event.status === 'failed') {
    return (
      <Box>
        <Text color={t.textDim}>implementer ({event.model ?? '?'})</Text>
        <Text color={t.error}>  failed</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.textDim}>implementer ({event.model ?? '?'}){dur}</Text>
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

function ValidateCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'validate' }>; theme: Theme }) {
  const dur = event.duration ? ` ${formatDuration(event.duration)}` : '';

  const stageIcon = (passed: boolean) => passed
    ? <Text color={t.success}>✓</Text>
    : <Text color={t.error}>✗</Text>;

  if (event.status === 'running') {
    const currentStage = !event.stages.tsc ? 'tsc' : !event.stages.lint ? 'lint' : 'test';
    return <Spinner label={`validating ${currentStage}...`} color={t.validator} />;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.validator}>validator</Text>
        <Text color={t.textDim}>{dur}</Text>
      </Box>
      <Box marginLeft={2} gap={2}>
        <Text color={t.textDim}>tsc {stageIcon(event.stages.tsc)}</Text>
        <Text color={t.textDim}>lint {stageIcon(event.stages.lint)}</Text>
        <Text color={t.textDim}>test {stageIcon(event.stages.test)}</Text>
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
        <Text color={t.warning} bold>escalate </Text>
        <Text color={t.textDim}>tier {event.tier}</Text>
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

function ErrorCard({ event, theme: t }: { event: Extract<TuiEvent, { type: 'error' }>; theme: Theme }) {
  return (
    <Box>
      <Text color={t.error}>error </Text>
      <Text color={t.error}>{event.message}</Text>
    </Box>
  );
}

export function renderEvent(event: TuiEvent, t: Theme, diffExpanded?: boolean): React.JSX.Element | null {
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

    case 'error':
      return <ErrorCard event={event} theme={t} />;
  }
}

export default function EventCard({ event, diffExpanded }: EventCardProps) {
  const { theme: t } = useAppContext();
  return renderEvent(event, t, diffExpanded);
}

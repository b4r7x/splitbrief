import { Box, Text } from 'ink';
import type { TuiEvent } from '../types.js';
import DiffView from './diff-view.js';

interface EventCardProps {
  event: TuiEvent;
  diffExpanded?: boolean;
}

function StageIndicator({ label, passed }: { label: string; passed: boolean }) {
  return (
    <Text>
      {label} {passed ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}
    </Text>
  );
}

export default function EventCard({ event, diffExpanded }: EventCardProps) {
  switch (event.type) {
    case 'planner-status': {
      const label = event.status === 'done'
        ? `● Planner ${event.phase} done${event.duration ? ` (${(event.duration / 1000).toFixed(1)}s)` : ''}`
        : `● Planner ${event.phase}...`;
      return (
        <Box>
          <Text color="blue" bold>{label}</Text>
          {event.summary && <Text color="gray"> — {event.summary}</Text>}
        </Box>
      );
    }

    case 'planner-text':
      return (
        <Box marginLeft={2}>
          <Text color="gray">{event.text}</Text>
        </Box>
      );

    case 'task-start':
      return (
        <Box>
          <Text bold>─── T{event.index + 1}: {event.title} ───</Text>
        </Box>
      );

    case 'task-complete':
      return null;

    case 'task-skipped':
      return (
        <Box>
          <Text color="gray">⊘ T{event.taskId} {event.title} — skipped: {event.reason}</Text>
        </Box>
      );

    case 'implementer-generate': {
      if (event.status === 'running') {
        return (
          <Box>
            <Text color="green">⚡ implementer.generate({event.model ?? '?'})</Text>
            <Text color="gray">  running...</Text>
          </Box>
        );
      }
      const dur = event.duration ? `  ${(event.duration / 1000).toFixed(1)}s` : '';
      const statusColor = event.status === 'failed' ? 'red' : 'green';
      const statusSuffix = event.status === 'failed' ? '  failed' : dur;
      const lineSummary = event.linesAdded != null || event.linesRemoved != null
        ? ` (+${event.linesAdded ?? 0} -${event.linesRemoved ?? 0})`
        : '';
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={statusColor}>⚡ implementer.generate({event.model ?? '?'})</Text>
            <Text>{statusSuffix}</Text>
          </Box>
          {event.file && event.diff != null && event.linesAdded != null && event.linesRemoved != null ? (
            <DiffView
              file={event.file}
              linesAdded={event.linesAdded}
              linesRemoved={event.linesRemoved}
              diff={event.diff}
              expanded={diffExpanded ?? false}
            />
          ) : event.file ? (
            <Box marginLeft={4}>
              <Text color="gray">→ {event.file}{lineSummary}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }

    case 'validate': {
      const mark = event.passed ? <Text color="green">✓</Text> : <Text color="red">✗</Text>;
      const dur = event.duration ? ` ${(event.duration / 1000).toFixed(1)}s` : '';
      return (
        <Box flexDirection="column">
          <Box>
            <Text>⚡ validate(tsc, lint, test)  {mark}{dur}</Text>
          </Box>
          <Box marginLeft={4} gap={2}>
            <StageIndicator label="tsc" passed={event.stages.tsc} />
            <StageIndicator label="lint" passed={event.stages.lint} />
            <StageIndicator label="test" passed={event.stages.test} />
          </Box>
          {event.error && (
            <Box marginLeft={4}>
              <Text color="red">{event.error}</Text>
            </Box>
          )}
        </Box>
      );
    }

    case 'retry':
      return (
        <Box>
          <Text color="yellow">⚡ retry(attempt {event.attempt}/{event.maxRetries})</Text>
        </Box>
      );

    case 'escalate':
      return (
        <Box flexDirection="column">
          <Box>
            <Text color="yellow" bold>⚠ escalate(tier {event.tier})</Text>
          </Box>
          {event.hint && (
            <Box marginLeft={4}>
              <Text color="gray">{event.hint}</Text>
            </Box>
          )}
        </Box>
      );

    case 'git-commit':
      return (
        <Box>
          <Text color="gray">⚡ git.commit("{event.message}")</Text>
        </Box>
      );

    case 'error':
      return (
        <Box>
          <Text color="red" bold>✗ Error: {event.message}</Text>
        </Box>
      );
  }
}

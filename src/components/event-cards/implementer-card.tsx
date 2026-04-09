import { Box, Text } from 'ink';
import type { TuiEvent } from '../../types.js';
import { useTheme } from '../../ui/theme.js';
import DiffView from '../../ui/diff-view.js';
import { Spinner } from '../../ui/spinner.js';
import { formatDuration } from '../../utils/format.js';
import { formatModelName } from '../../core/providers/models.js';
import { Card } from './card.js';

export function ImplementerCard({ event, diffExpanded }: { event: Extract<TuiEvent, { type: 'implementer-generate' }>; diffExpanded: boolean }) {
  const t = useTheme();

  if (event.status === 'running') {
    const fileHint = event.file ? `generating ${event.file}...` : 'generating...';
    return <Spinner label={fileHint} color={t.implementer} startTime={event.ts} />;
  }

  if (event.status === 'failed') {
    return (
      <Card
        label={formatModelName(event.model)}
        labelColor={t.implementer}
        value="failed"
        valueColor={t.error}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.implementer}>{event.file}</Text>
        <Text color={t.textDim}>  {formatDuration(event.duration)}</Text>
      </Box>
      {event.diff != null ? (
        <DiffView
          file={event.file}
          linesAdded={event.linesAdded}
          linesRemoved={event.linesRemoved}
          diff={event.diff}
          expanded={diffExpanded}
        />
      ) : (
        <Box>
          <Text color={t.textDim}>  {event.file} (+{event.linesAdded} -{event.linesRemoved})</Text>
        </Box>
      )}
    </Box>
  );
}

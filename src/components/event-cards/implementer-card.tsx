import { Box, Text } from 'ink';
import type { TuiEvent } from '../../types.js';
import { terminalSizeStore } from '../../stores/terminal-size.js';
import { useTheme } from '../../ui/theme.js';
import { DiffView } from '../../ui/diff-view.js';
import { Spinner } from '../../ui/spinner.js';
import { formatDuration } from '../../utils/format.js';
import { formatModelName } from '../../core/providers/models.js';
import { Card } from './card.js';

export type ImplementerGenerateEvent = Extract<
  TuiEvent,
  { type: 'implementer-generate-running' | 'implementer-generate-done' | 'implementer-generate-failed' }
>;

export function ImplementerCard({ event, diffExpanded }: { event: ImplementerGenerateEvent; diffExpanded: boolean }) {
  const t = useTheme();
  const rows = terminalSizeStore.use(s => s.rows);

  if (event.type === 'implementer-generate-running') {
    const fileHint = event.file ? `generating ${event.file}...` : 'generating...';
    return <Spinner label={fileHint} color={t.implementer} startTime={event.ts} />;
  }

  if (event.type === 'implementer-generate-failed') {
    return (
      <Card
        label={formatModelName(event.model)}
        labelColor={t.implementer}
        value="failed"
        valueColor={t.error}
      />
    );
  }

  const header = (
    <Box>
      <Text color={t.implementer}>{event.file}</Text>
      <Text color={t.textDim}>  {formatDuration(event.duration)}</Text>
    </Box>
  );

  const body = event.diff != null ? (
    <DiffView
      file={event.file}
      linesAdded={event.linesAdded}
      linesRemoved={event.linesRemoved}
      diff={event.diff}
      expanded={diffExpanded}
      rows={rows}
    />
  ) : (
    <Box>
      <Text color={t.textDim}>  {event.file} (+{event.linesAdded} -{event.linesRemoved})</Text>
    </Box>
  );

  return <Card header={header} body={body} />;
}

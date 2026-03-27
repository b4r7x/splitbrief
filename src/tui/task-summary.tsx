import { Box, Text } from 'ink';

interface TaskSummaryProps {
  index: number;
  title: string;
  method: 'local' | 'escalated' | 'failed' | 'skipped';
  retries?: number;
  duration?: number;
  reason?: string;
}

export default function TaskSummary({ index, title, method, retries, duration, reason }: TaskSummaryProps) {
  if (method === 'failed') {
    return (
      <Box>
        <Text color="red">{`  \u2717 T${index} ${title} \u2014 failed`}</Text>
      </Box>
    );
  }

  if (method === 'skipped') {
    return (
      <Box>
        <Text color="gray">{`  \u25CB T${index} ${title} \u2014 skipped${reason ? `: ${reason}` : ''}`}</Text>
      </Box>
    );
  }

  const parts = [`T${index} ${title} \u2014 ${method}`];
  if (retries && retries > 0) parts.push(`${retries} ${retries === 1 ? 'retry' : 'retries'}`);
  if (duration != null) parts.push(`${duration}s`);

  return (
    <Box>
      <Text color="green">{`  \u2713 ${parts.join(', ')}`}</Text>
    </Box>
  );
}

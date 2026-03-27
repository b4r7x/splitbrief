import { Box, Text } from 'ink';

export interface DiffViewProps {
  file: string;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  expanded: boolean;
}

const MAX_LINES = 50;

export default function DiffView({ file, linesAdded, linesRemoved, diff, expanded }: DiffViewProps) {
  if (!expanded) {
    return (
      <Box>
        <Text>    → {file} </Text>
        <Text color="green">(+{linesAdded}</Text>
        <Text> </Text>
        <Text color="red">-{linesRemoved})</Text>
      </Box>
    );
  }

  const lines = diff ? diff.split('\n').filter(l => l.length > 0) : [];

  if (lines.length === 0) {
    return (
      <Box>
        <Text>    → {file} (+{linesAdded} -{linesRemoved})</Text>
      </Box>
    );
  }

  const visible = lines.slice(0, MAX_LINES);
  const remaining = lines.length - visible.length;

  return (
    <Box flexDirection="column">
      <Text>    → {file} (+{linesAdded} -{linesRemoved})</Text>
      <Box flexDirection="column" marginLeft={4}>
        {visible.map((line, i) => {
          if (line.startsWith('+ ')) return <Text key={i} color="green">{line}</Text>;
          if (line.startsWith('- ')) return <Text key={i} color="red">{line}</Text>;
          return <Text key={i} dimColor>{line}</Text>;
        })}
        {remaining > 0 && <Text dimColor>    ...{remaining} more lines</Text>}
      </Box>
    </Box>
  );
}

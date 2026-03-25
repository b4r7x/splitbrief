import { useState, useMemo, useImperativeHandle, forwardRef } from 'react';
import { Box, Text } from 'ink';

export interface PaneProps {
  title: string;
  lines: string[];
  focused: boolean;
  height: number;
  width?: number | string;
}

export interface PaneHandle {
  scrollUp: () => void;
  scrollDown: () => void;
}

const Pane = forwardRef<PaneHandle, PaneProps>(function Pane({ title, lines, focused, height, width }, ref) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleCount = Math.max(0, height - 2);

  const visibleLines = useMemo(() => {
    if (lines.length <= visibleCount) {
      return lines;
    }
    const end = lines.length - scrollOffset;
    const start = Math.max(0, end - visibleCount);
    return lines.slice(start, Math.max(start, end));
  }, [lines, visibleCount, scrollOffset]);

  useImperativeHandle(ref, () => ({
    scrollUp() {
      setScrollOffset(prev => Math.min(prev + 1, Math.max(0, lines.length - visibleCount)));
    },
    scrollDown() {
      setScrollOffset(prev => Math.max(0, prev - 1));
    },
  }), [lines.length, visibleCount]);

  const borderColor = focused ? 'cyan' : 'gray';

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      height={height}
      width={width}
    >
      <Box>
        <Text bold color={borderColor}>{title}</Text>
      </Box>
      {visibleLines.map((line, i) => (
        <Text key={i} wrap="truncate">{line}</Text>
      ))}
    </Box>
  );
});

export default Pane;

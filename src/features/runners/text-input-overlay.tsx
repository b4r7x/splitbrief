import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from '../../components/input/multiline-input.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getClampedTerminalWidth } from '../../utils/terminal-width.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { glyph } from '../../lib/glyphs.js';

interface TextInputOverlayProps {
  title: ReactNode;
  label: ReactNode;
  placeholder: string;
  initialValue?: string;
  examples?: string[];
  rows?: number;
  maxRows?: number;
  onSubmit: (value: string) => void;
}

export function TextInputOverlay({
  title,
  label,
  placeholder,
  initialValue = '',
  examples,
  rows = 1,
  maxRows = 1,
  onSubmit,
}: TextInputOverlayProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const termRows = terminalSizeStore.use((s) => s.rows);
  const [value, setValue] = useState(initialValue);
  const focus = overlayStore.use(
    (s) =>
      s.active === 'none' || s.active === 'planner-picker' || s.active === 'implementer-picker',
  );

  useEffect(() => {
    overlayStore.setExclusive(true);
    return () => {
      overlayStore.setExclusive(false);
    };
  }, []);

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <Box width={cols} height={termRows} alignItems="center" justifyContent="center">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={t.textDim}>{title}</Text>
        </Box>
        <Text color={t.textDim}>{label}</Text>
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor={t.border}
          paddingX={1}
          width={getClampedTerminalWidth({ cols, maxWidth: 60, gutter: 12 })}
        >
          <Text color={t.accent}>{`${glyph('prompt')} `}</Text>
          <Box flexGrow={1}>
            <MultilineInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
              rows={rows}
              maxRows={maxRows}
              placeholder={placeholder}
              focus={focus}
              keyBindings={{
                submit: (key) => key.return,
                newline: () => false,
              }}
            />
          </Box>
        </Box>
        {examples && examples.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text color={t.textDim} dimColor>
              Examples
            </Text>
            {examples.map((ex) => (
              <Text key={ex} color={t.textDim} dimColor>
                {'  '}
                {ex}
              </Text>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={t.textDim}>{`⏎ save${SOFT_SEP}esc back`}</Text>
        </Box>
      </Box>
    </Box>
  );
}

import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { OverlayPanel } from './overlay-panel.js';
import { MultilineInput } from '../input/multiline-input.js';
import { useTheme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getClampedTerminalWidth } from '../../utils/terminal-width.js';
import { overlayStore } from '../../stores/ui/overlay.js';

interface TextInputOverlayProps {
  title: string;
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
  const [value, setValue] = useState(initialValue);

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
    <OverlayPanel title={title} hint="Enter to save  Esc to go back" width="auto" maxWidth={70}>
      <Box flexDirection="column" gap={1}>
        <Text color={t.textDim}>{label}</Text>
        <Box
          borderStyle="round"
          borderColor={t.accent}
          paddingX={1}
          width={getClampedTerminalWidth(cols, 60, 12)}
        >
          <Box flexGrow={1}>
            <MultilineInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
              rows={rows}
              maxRows={maxRows}
              placeholder={placeholder}
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
              Examples:
            </Text>
            {examples.map((ex) => (
              <Text key={ex} color={t.textDim} dimColor>
                {' '}
                {ex}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </OverlayPanel>
  );
}

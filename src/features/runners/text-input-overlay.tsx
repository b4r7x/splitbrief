import { useState, useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from '../../components/input/multiline-input.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import type { SeatPickerRole } from '../../core/runners/cli-tool-catalog.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { overlayAllowsPickerKeys } from '../../core/navigation/types.js';

interface TextInputOverlayProps {
  title: string;
  role: SeatPickerRole;
  stepIndicator?: ReactElement | undefined;
  recap?: ReactElement | undefined;
  label: ReactNode;
  placeholder: string;
  initialValue?: string;
  mask?: string | undefined;
  helper?: string | undefined;
  examples?: string[] | undefined;
  hint?: string | undefined;
  rows?: number;
  maxRows?: number;
  onChange?: ((value: string) => void) | undefined;
  onSubmit: (value: string) => void;
}

export function TextInputOverlay({
  title,
  role,
  stepIndicator,
  recap,
  label,
  placeholder,
  initialValue = '',
  mask,
  helper,
  examples,
  hint,
  rows = 1,
  maxRows = 1,
  onChange,
  onSubmit,
}: TextInputOverlayProps) {
  const t = useTheme();
  const [value, setValue] = useState(initialValue);
  const [visibleRows, setVisibleRows] = useState(rows);
  const focus = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));

  useEffect(() => {
    overlayStore.setExclusive(true);
    return () => {
      overlayStore.setExclusive(false);
    };
  }, []);

  const handleChange = (next: string) => {
    setValue(next);
    onChange?.(next);
  };

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) onSubmit(trimmed);
  };

  // Keep the panel height constant while the input grows: the helper line
  // yields first, then the examples. The input reports its actual rendered
  // rows, so word-wrap never outgrows an estimate.
  const showHelper = helper !== undefined && visibleRows < 2;
  const showExamples = examples !== undefined && examples.length > 0 && visibleRows < 3;
  const spacedExamples = helper === undefined;

  return (
    <OverlayPanel
      density="roomy"
      title={sanitizeTerminalDisplayText(`${title}${SOFT_SEP}${role}`)}
      hint={hint ?? `⏎ save${SOFT_SEP}esc back`}
    >
      {stepIndicator ? (
        <Box flexDirection="column">
          {stepIndicator}
          <Box height={1} />
        </Box>
      ) : null}
      {recap ? (
        <Box flexDirection="column">
          {recap}
          <Box height={1} />
        </Box>
      ) : null}
      <Box height={1} overflow="hidden">
        <Text color={t.text} wrap="truncate-end">
          {label}
        </Text>
      </Box>
      <Box borderStyle={borderStyleFor('round')} borderColor={t.border} paddingX={1}>
        <Text color={t.accent}>{`${glyph('prompt')} `}</Text>
        <Box flexGrow={1}>
          <MultilineInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            rows={rows}
            maxRows={maxRows}
            mask={mask}
            placeholder={placeholder}
            keepPlaceholderWhileFocused
            focus={focus}
            onVisibleRowsChange={setVisibleRows}
            keyBindings={{
              submit: (key) => key.return,
              newline: () => false,
            }}
          />
        </Box>
      </Box>
      {showHelper ? (
        <Box height={1} overflow="hidden">
          <Text color={t.textDim} wrap="truncate-end">
            {helper}
          </Text>
        </Box>
      ) : null}
      {showExamples && examples ? (
        <Box flexDirection="column">
          {spacedExamples ? <Box height={1} /> : null}
          {examples.map((example, exampleIndex) => (
            <Box key={example} height={1} overflow="hidden">
              <Text color={t.textDim} wrap="truncate-end">
                {`${exampleIndex === 0 ? 'e.g. ' : '     '}${example}`}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </OverlayPanel>
  );
}

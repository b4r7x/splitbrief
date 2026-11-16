import { Box } from 'ink';
import { MultilineInput } from '../../../components/input/field.js';
import { useTheme, ThemeText as Text } from '../../../components/theme.js';
import { glyph } from '../../../lib/glyphs.js';

export const LABEL_WIDTH = 10;

export function DimLine({ text, tone = 'dim' }: { text: string; tone?: 'warning' | 'dim' }) {
  const t = useTheme();
  return (
    <Box height={1} overflow="hidden">
      <Text color={tone === 'warning' ? t.warning : t.textDim} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}

export function FieldRow(props: {
  label: string;
  value: string;
  placeholder: string;
  focused: boolean;
  columns: number;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onLeave: (direction: 'up' | 'down') => void;
}) {
  const t = useTheme();
  return (
    <Box height={1} overflow="hidden">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text color={props.focused ? t.accent : t.textDim}>
          {`${props.focused ? glyph('liveBar') : ' '} ${props.label}`}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={0}>
        <MultilineInput
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          rows={1}
          maxRows={1}
          columns={props.columns}
          placeholder={props.placeholder}
          keepPlaceholderWhileFocused
          focus={props.focused}
          onBoundaryNavigate={(direction) => {
            props.onLeave(direction);
          }}
          keyBindings={{ submit: (key) => key.return, newline: () => false }}
        />
      </Box>
    </Box>
  );
}

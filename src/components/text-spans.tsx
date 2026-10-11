import { ThemeText as Text, useTheme } from './theme.js';
import { colorForTone, type TextTone } from '../core/theme/tone-color.js';

type TextSpan = Readonly<{ text: string; bold?: boolean }> &
  ({ tone: TextTone; color?: never } | { color: string | undefined; tone?: never });

export function TextSpans({
  parts,
  selected = false,
}: {
  parts: readonly TextSpan[];
  selected?: boolean;
}) {
  const t = useTheme();
  return parts.map((part, index) => (
    <Text
      key={index}
      color={
        'color' in part
          ? part.color
          : colorForTone(selected && part.tone === 'text' ? 'accent' : part.tone, t)
      }
      bold={part.bold === true}
    >
      {part.text}
    </Text>
  ));
}

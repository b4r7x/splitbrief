import { PanelSurface } from '../../../components/overlays/surface.js';
import type { ReactNode } from 'react';
import { fitKeyLegend } from '../../../components/key-legend.js';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { borderStyleFor } from '../../../lib/glyphs.js';

export function InlineMenuPanel({
  width,
  height,
  framed,
  focused,
  title,
  legend,
  children,
}: {
  width: number;
  height: number;
  framed: boolean;
  focused: boolean;
  title?: ReactNode;
  legend?: string | undefined;
  children: ReactNode;
}) {
  const t = useTheme();
  return (
    <PanelSurface
      width={width}
      height={height}
      {...(framed && {
        borderStyle: borderStyleFor('single'),
        borderColor: focused ? t.accent : t.border,
        borderDimColor: !focused,
      })}
      paddingX={framed ? 1 : 2}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
    >
      {title !== undefined && (
        <Text color={t.textDim} wrap="truncate-end">
          {title}
        </Text>
      )}
      {children}
      {legend !== undefined && (
        <Text color={t.textDim} wrap="truncate-end">
          {fitKeyLegend(legend, Math.max(1, width - 4))}
        </Text>
      )}
    </PanelSurface>
  );
}

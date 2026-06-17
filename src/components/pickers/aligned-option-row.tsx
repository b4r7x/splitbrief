import type { ReactNode } from 'react';
import { Box, Text, type TextProps } from 'ink';
import { getTerminalCellWidth, stripTerminalControls } from '../../lib/terminal/display-text.js';

export interface AlignedOptionLabelWidthOptions {
  gap: number;
  maxWidth?: number | undefined;
  minWidth?: number | undefined;
}

export function getAlignedOptionLabelWidth(
  labels: readonly string[],
  { gap, maxWidth, minWidth = 0 }: AlignedOptionLabelWidthOptions,
): number {
  const longest = labels.reduce((max, label) => Math.max(max, getTerminalCellWidth(label)), 0);
  const width = Math.max(minWidth, longest + gap);
  return maxWidth === undefined ? width : Math.min(maxWidth, width);
}

export interface AlignedOptionRowMeta {
  text: string;
  width: number;
  color?: string | undefined;
}

export interface AlignedOptionRowProps {
  lead?: ReactNode | undefined;
  leadGap?: number | undefined;
  meta?: AlignedOptionRowMeta | undefined;
  metaGap?: number | undefined;
  label: string;
  labelWidth: number;
  labelColor?: string | undefined;
  labelBold?: boolean | undefined;
  detail?: string | undefined;
  detailColor?: string | undefined;
  detailWrap?: TextProps['wrap'] | undefined;
  backgroundColor?: string | undefined;
}

export function AlignedOptionRow({
  lead,
  leadGap = 0,
  meta,
  metaGap = 1,
  label,
  labelWidth,
  labelColor,
  labelBold,
  detail,
  detailColor,
  detailWrap = 'truncate-end',
  backgroundColor,
}: AlignedOptionRowProps) {
  const cleanMeta = meta ? { ...meta, text: stripTerminalControls(meta.text) } : undefined;
  const cleanLabel = stripTerminalControls(label);
  const cleanDetail = detail === undefined ? undefined : stripTerminalControls(detail);

  return (
    <Box width="100%" height={1} overflow="hidden" backgroundColor={backgroundColor}>
      {lead}
      {leadGap > 0 ? (
        <Box width={leadGap} flexShrink={0} backgroundColor={backgroundColor} />
      ) : null}
      {cleanMeta ? (
        <>
          <Box
            width={cleanMeta.width}
            flexShrink={0}
            overflow="hidden"
            backgroundColor={backgroundColor}
          >
            <Text
              {...(cleanMeta.color !== undefined ? { color: cleanMeta.color } : {})}
              wrap="truncate-end"
            >
              {cleanMeta.text}
            </Text>
          </Box>
          {metaGap > 0 ? (
            <Box width={metaGap} flexShrink={0} backgroundColor={backgroundColor} />
          ) : null}
        </>
      ) : null}
      <Box width={labelWidth} flexShrink={0} overflow="hidden" backgroundColor={backgroundColor}>
        <Text
          {...(labelColor !== undefined ? { color: labelColor } : {})}
          {...(labelBold !== undefined ? { bold: labelBold } : {})}
          wrap="truncate-end"
        >
          {cleanLabel}
        </Text>
      </Box>
      {cleanDetail ? (
        <Box
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          overflow="hidden"
          backgroundColor={backgroundColor}
        >
          <Text {...(detailColor !== undefined ? { color: detailColor } : {})} wrap={detailWrap}>
            {cleanDetail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

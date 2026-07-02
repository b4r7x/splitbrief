import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { glyph } from '../../../lib/glyphs.js';
import { assertNever } from '../../../utils/type-guards.js';
import { promptBodyRows, type PromptBodyLine } from '../prompt-body-rows.js';
import { passHeadlinePrefix } from '../recovery-prompt.js';

type Theme = ReturnType<typeof useTheme>;

const MIN_PROMPT_WIDTH = 1;

function renderHeadline(
  row: Extract<PromptBodyLine, { kind: 'headline' }>['row'],
  key: string,
  t: Theme,
): ReactNode {
  if (row.tone === 'pass') {
    return (
      <Text key={key} wrap="truncate">
        <Text color={t.success}>{passHeadlinePrefix()}</Text>
        <Text color={t.text}>{row.text || ' '}</Text>
      </Text>
    );
  }
  if (row.tone === 'failed') {
    if (row.detail !== undefined) {
      return (
        <Text key={key} wrap="truncate">
          <Text color={t.textDim}>{`${row.text} `}</Text>
          <Text color={t.error} dimColor>
            failed
          </Text>
          <Text color={t.textDim}>{` review · ${row.detail}`}</Text>
        </Text>
      );
    }
    return (
      <Text key={key} wrap="truncate" color={t.error} dimColor>
        {row.text || ' '}
      </Text>
    );
  }
  return (
    <Text key={key} wrap="truncate" color={t.warning}>
      {row.text || ' '}
    </Text>
  );
}

function renderPromptRows(rows: PromptBodyLine[], width: number, t: Theme): ReactNode[] {
  const halfWidth = Math.floor(width / 2);
  const nodes: ReactNode[] = [];
  let counter = 0;
  const key = (): string => `prompt-${counter++}`;

  for (const row of rows) {
    switch (row.kind) {
      case 'blank':
        nodes.push(<Text key={key()}> </Text>);
        break;
      case 'message-line':
        nodes.push(
          <Text key={key()} wrap="truncate" color={t.warning}>
            {row.text || ' '}
          </Text>,
        );
        break;
      case 'headline':
        nodes.push(renderHeadline(row.row, key(), t));
        break;
      case 'facts-line':
        nodes.push(
          <Text key={key()} wrap="truncate" color={t.textDim}>
            {row.text || ' '}
          </Text>,
        );
        break;
      case 'facts-grid-pair':
        nodes.push(
          <Box key={key()} flexDirection="row" width={width - 2} marginLeft={2}>
            <Box width={halfWidth}>
              <Text wrap="truncate" color={t.textDim}>
                {row.left}
              </Text>
            </Box>
            <Text wrap="truncate" color={t.textDim}>
              {row.right}
            </Text>
          </Box>,
        );
        break;
      case 'action':
        if (row.recommended) {
          nodes.push(
            <Box key={key()} flexDirection="row" width={width}>
              <Text color={t.accent} bold>
                {`${glyph('liveBar')} `}
              </Text>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate">{row.text}</Text>
              </Box>
              <Text color={t.textDim}>{' recommended'}</Text>
            </Box>,
          );
        } else {
          nodes.push(<Text key={key()} wrap="truncate">{`  ${row.text}`}</Text>);
        }
        break;
      case 'note':
        nodes.push(
          <Text key={key()} wrap="truncate" color={t.textDim}>
            {`      ${row.text}`}
          </Text>,
        );
        break;
      default:
        return assertNever(row);
    }
  }
  return nodes;
}

export function PromptBody({
  prompt,
  height,
  width,
}: {
  prompt: string;
  height: number;
  width: number;
}) {
  const t = useTheme();
  if (height <= 0) return null;

  const promptWidth = Math.max(MIN_PROMPT_WIDTH, width);
  const rows = promptBodyRows(prompt, promptWidth);
  const nodes = renderPromptRows(rows, promptWidth, t).slice(0, height);

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      {nodes}
    </Box>
  );
}

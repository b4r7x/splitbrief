import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import type { ReactNode } from 'react';
import { Box } from 'ink';
import { assertNever } from '../../../utils/type-guards.js';
import {
  clipPromptBodyRows,
  fitRecommendedText,
  promptBodyRows,
  type PromptBodyLine,
} from '../prompt-body-rows.js';
import { passHeadlinePrefix } from '../recovery-prompt.js';

type Theme = ReturnType<typeof useTheme>;

const MIN_PROMPT_WIDTH = 1;
const ACTION_LEAD = '  ';
const ACTION_GAP = '   ';
const RECOMMENDED_TAIL = ' recommended';

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
          <Text color={t.dimError}>failed</Text>
          <Text color={t.textDim}>{` review · ${row.detail}`}</Text>
        </Text>
      );
    }
    return (
      <Text key={key} wrap="truncate" color={t.dimError}>
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
      case 'action': {
        const indent = ACTION_LEAD.length + row.keyWidth + ACTION_GAP.length;
        const room = Math.max(1, width - indent);
        const text = row.recommended ? fitRecommendedText(row.text, room) : row.text;
        nodes.push(
          <Text key={key()} wrap="truncate">
            {ACTION_LEAD}
            <Text color={t.textDim}>{row.key.padEnd(row.keyWidth)}</Text>
            {ACTION_GAP}
            {text}
            {row.recommended ? <Text color={t.textDim}>{RECOMMENDED_TAIL}</Text> : null}
          </Text>,
        );
        break;
      }
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
  const rows = clipPromptBodyRows(promptBodyRows(prompt, promptWidth), height);
  const nodes = renderPromptRows(rows, promptWidth, t);

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      {nodes}
    </Box>
  );
}

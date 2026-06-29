import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { glyph } from '../../../lib/glyphs.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { wrapHard } from '../../../utils/wrap.js';
import {
  FAILED_REVIEW_MARKER,
  isActionRowLine,
  passHeadlinePrefix,
  type PromptRow,
  recommendedRowPrefix,
} from '../recovery-prompt.js';

type Theme = ReturnType<typeof useTheme>;

const MIN_PROMPT_WIDTH = 1;
const GRID_MIN_WIDTH = 52;

function clean(text: string, multiline = false): string {
  return sanitizeTerminalDisplayText(text, { preserveLineBreaks: multiline });
}

// Prompts cross the question-mode UI channel as flat strings (the channel is typed
// `hint: string`), so the structured rows the builders produce are serialized via
// promptRowsToString and reconstructed here. tone and grid are recovered from the
// shared headline markers so the renderer reproduces the builders' intent exactly.
function parseHeadline(headline: string): Extract<PromptRow, { kind: 'headline' }> {
  const passPrefix = passHeadlinePrefix();
  if (headline.startsWith(passPrefix)) {
    return { kind: 'headline', tone: 'pass', text: headline.slice(passPrefix.length) };
  }
  const marker = headline.indexOf(FAILED_REVIEW_MARKER);
  if (marker !== -1) {
    return {
      kind: 'headline',
      tone: 'failed',
      text: headline.slice(0, marker),
      detail: headline.slice(marker + FAILED_REVIEW_MARKER.length),
    };
  }
  return { kind: 'headline', tone: 'attention', text: headline };
}

function parsePromptRows(prompt: string): PromptRow[] {
  const lines = clean(prompt, true).split('\n');
  const headline = parseHeadline(lines[0] ?? '');
  const body = lines.slice(1);
  const actionStart = body.findIndex(isActionRowLine);
  const factLines = (actionStart === -1 ? body : body.slice(0, actionStart)).filter(
    (line) => line.trim().length > 0,
  );
  const actionLines = actionStart === -1 ? [] : body.slice(actionStart);

  if (factLines.length === 0 && actionLines.length === 0) {
    return headline.tone === 'attention' ? [{ kind: 'message', text: headline.text }] : [headline];
  }

  const rows: PromptRow[] = [headline];
  if (factLines.length > 0) {
    rows.push(
      { kind: 'blank' },
      { kind: 'facts', items: factLines, grid: headline.tone === 'pass' },
    );
  }
  if (actionLines.length > 0) {
    rows.push({ kind: 'blank' });
    for (const line of actionLines) {
      if (line.trim().length === 0) {
        rows.push({ kind: 'blank' });
        continue;
      }
      if (!isActionRowLine(line)) {
        rows.push({ kind: 'note', text: line });
        continue;
      }
      const rowPrefix = recommendedRowPrefix();
      const recommended = line.startsWith(rowPrefix);
      rows.push({
        kind: 'action',
        text: recommended ? line.slice(rowPrefix.length) : line,
        recommended,
      });
    }
  }
  return rows;
}

function renderHeadline(
  row: Extract<PromptRow, { kind: 'headline' }>,
  key: string,
  t: Theme,
): ReactNode {
  if (row.tone === 'pass') {
    return (
      <Text key={key} wrap="truncate">
        <Text color={t.success}>{passHeadlinePrefix()}</Text>
        <Text color={t.text}>{clean(row.text) || ' '}</Text>
      </Text>
    );
  }
  if (row.tone === 'failed') {
    if (row.detail !== undefined) {
      return (
        <Text key={key} wrap="truncate">
          <Text color={t.textDim}>{`${clean(row.text)} `}</Text>
          <Text color={t.error} dimColor>
            failed
          </Text>
          <Text color={t.textDim}>{` review · ${clean(row.detail)}`}</Text>
        </Text>
      );
    }
    return (
      <Text key={key} wrap="truncate" color={t.error} dimColor>
        {clean(row.text) || ' '}
      </Text>
    );
  }
  return (
    <Text key={key} wrap="truncate" color={t.warning}>
      {clean(row.text) || ' '}
    </Text>
  );
}

function renderPromptRows(rows: PromptRow[], width: number, t: Theme): ReactNode[] {
  const halfWidth = Math.floor(width / 2);
  const nodes: ReactNode[] = [];
  let counter = 0;
  const key = (): string => `prompt-${counter++}`;

  for (const row of rows) {
    switch (row.kind) {
      case 'blank':
        nodes.push(<Text key={key()}> </Text>);
        break;
      case 'message':
        for (const line of wrapHard(clean(row.text, true), width).split('\n')) {
          nodes.push(
            <Text key={key()} wrap="truncate" color={t.warning}>
              {line || ' '}
            </Text>,
          );
        }
        break;
      case 'headline':
        nodes.push(renderHeadline(row, key(), t));
        break;
      case 'facts':
        if (row.grid && width >= GRID_MIN_WIDTH) {
          for (let i = 0; i < row.items.length; i += 2) {
            const left = clean(row.items[i] ?? '');
            const right = row.items[i + 1];
            if (right === undefined) {
              nodes.push(
                <Text key={key()} color={t.textDim}>
                  {`  ${left}`}
                </Text>,
              );
            } else {
              nodes.push(
                <Box key={key()} flexDirection="row" width={width - 2} marginLeft={2}>
                  <Box width={halfWidth}>
                    <Text wrap="truncate" color={t.textDim}>
                      {left}
                    </Text>
                  </Box>
                  <Text wrap="truncate" color={t.textDim}>
                    {clean(right)}
                  </Text>
                </Box>,
              );
            }
          }
        } else {
          for (const item of row.items) {
            for (const line of wrapHard(clean(item, true), width).split('\n')) {
              nodes.push(
                <Text key={key()} color={t.textDim}>
                  {`  ${line}`}
                </Text>,
              );
            }
          }
        }
        break;
      case 'action':
        if (row.recommended) {
          nodes.push(
            <Box key={key()} flexDirection="row" width={width}>
              <Text color={t.accent} bold>
                {`${glyph('liveBar')} `}
              </Text>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate">{clean(row.text)}</Text>
              </Box>
              <Text color={t.textDim}>{' recommended'}</Text>
            </Box>,
          );
        } else {
          nodes.push(<Text key={key()} wrap="truncate">{`  ${clean(row.text)}`}</Text>);
        }
        break;
      case 'note':
        nodes.push(
          <Text key={key()} wrap="truncate" color={t.textDim}>
            {`      ${clean(row.text)}`}
          </Text>,
        );
        break;
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
  const rows = parsePromptRows(prompt);
  const nodes = renderPromptRows(rows, promptWidth, t).slice(0, height);

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      {nodes}
    </Box>
  );
}

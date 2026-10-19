import { Box } from 'ink';
import { ThemeText as Text, useTheme } from './theme.js';
import { sanitizeTerminalDisplayText } from '../utils/display-text.js';
import { wrapPathAware } from '../utils/wrap.js';

export interface FeedbackNoticeLayout {
  readonly text: string;
  readonly isError: boolean;
  /** The blank row above the notice plus its own rows. */
  readonly rows: number;
}

/**
 * The feedback line a panel shows under its list, laid out before the panel budgets its rows:
 * a confirmation wraps whole, so its path is never cut; an error keeps one row.
 */
export function layoutFeedbackNotice(
  feedback: Readonly<{ message: string | null; isError: boolean }>,
  width: number,
): FeedbackNoticeLayout | null {
  if (feedback.message === null) return null;
  const clean = sanitizeTerminalDisplayText(feedback.message);
  if (feedback.isError) return { text: clean, isError: true, rows: 2 };
  const text = wrapPathAware(clean, width);
  return { text, isError: false, rows: 1 + text.split('\n').length };
}

export function FeedbackNotice({ notice, width }: { notice: FeedbackNoticeLayout; width: number }) {
  const t = useTheme();
  return (
    <Box marginTop={1} width={width}>
      <Text color={notice.isError ? t.error : t.success} wrap="truncate-end">
        {notice.text}
      </Text>
    </Box>
  );
}

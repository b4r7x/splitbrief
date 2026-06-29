import { afterEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { Summary } from '../../core/schemas/summary.js';
import { taskId } from '../../core/schemas/task.js';
import { useTheme } from '../../components/theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { buildSummaryDetailRows } from './detail-rows.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function DetailRows({ summary }: { summary: Summary }) {
  const theme = useTheme();
  const rows = buildSummaryDetailRows({
    summary,
    evidenceLedger: null,
    sessionId: undefined,
    labelWidth: 20,
    taskTitleWidth: 60,
    truncateLength: 58,
    theme,
    isSmall: false,
    isShortSmall: false,
  });
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>
  );
}

describe('buildSummaryDetailRows', () => {
  afterEach(() => {
    terminalSizeStore.__testReset();
  });

  it('strips terminal-control bytes from persisted task titles before render', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <DetailRows
        summary={makeSummary({
          taskBreakdown: [
            {
              taskId: taskId('T001'),
              taskTitle: `Build ${ESC}]52;c;clipboard-task${BEL}panel${ESC}[31m`,
              method: 'local',
              implementerTokens: 10,
              escalationTokens: 0,
              retryCount: 0,
            },
          ],
        })}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('T001');
    expect(frame).toContain('Build');
    expect(frame).toContain('panel');
    expect(frame).not.toContain('clipboard-task');
    expect(frame).not.toContain('52;c');

    ui.unmount();
  });
});

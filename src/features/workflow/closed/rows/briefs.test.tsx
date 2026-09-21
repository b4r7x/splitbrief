import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { Summary } from '../../../../core/schemas/summary.js';
import type { RunStatus } from '../../../../core/sessions/run-status.js';
import { taskId } from '../../../../core/schemas/task.js';
import { glyph } from '../../../../lib/glyphs.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { deriveSummaryView } from '../view-model.js';
import { briefsSectionRows } from './briefs.js';

function renderBriefs(summary: Summary, status: RunStatus = { kind: 'closed', as: 'complete' }) {
  const view = deriveSummaryView({
    record: makeRunRecord({
      ref: { projectDir: '/tmp/closed-rows', sessionId: 'briefs-session' },
      summary,
      status,
    }),
  });
  if (view === null) throw new Error('expected a closed run to have a view');
  const rows = briefsSectionRows({ view, width: 90 });
  return renderFeature(
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>,
    { cols: 90, rows: 20 },
  );
}

describe('briefsSectionRows', () => {
  it('heads the ledger with a labelled rule and settles each brief on its own row', () => {
    const ui = renderBriefs(
      makeSummary({
        totalTasks: 2,
        completedByLocal: 1,
        escalatedToPlanner: 1,
        taskBreakdown: [
          {
            taskId: taskId('T001'),
            taskTitle: 'Add validator module',
            method: 'local',
            implementerTokens: 10,
            escalationTokens: 0,
            retryCount: 0,
          },
          {
            taskId: taskId('T002'),
            taskTitle: 'Wire the validator in',
            method: 'escalated-full',
            implementerTokens: 10,
            escalationTokens: 20,
            retryCount: 2,
          },
        ],
      }),
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`   Briefs ${glyph('divider')}`);
    expect(frame).toContain(` ${glyph('check')} T001 Add validator module`);
    expect(frame).toContain(` ${glyph('statusEscalated')} T002 Wire the validator in`);
    expect(frame).toContain('2 retries');

    ui.unmount();
  });

  it('marks the brief the run stopped inside and says what it left half written', () => {
    const ui = renderBriefs(
      makeSummary({
        totalTasks: 1,
        completedByLocal: 0,
        stoppedAt: {
          taskId: taskId('T001'),
          partialFiles: ['src/routes/signup.ts', 'src/routes/signup.test.ts'],
        },
        taskBreakdown: [
          {
            taskId: taskId('T001'),
            taskTitle: 'Add signup route tests',
            method: 'local',
            implementerTokens: 10,
            escalationTokens: 0,
            retryCount: 0,
          },
        ],
      }),
      { kind: 'closed', as: 'ended' },
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(` ${glyph('statusCancelled')} T001 Add signup route tests`);
    expect(frame).toContain('stopped');
    expect(frame).toContain('2 partial files');

    ui.unmount();
  });
});

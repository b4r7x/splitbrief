import { Box } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { Summary } from '../../../../core/schemas/summary.js';
import { taskId } from '../../../../core/schemas/task.js';
import { terminalTheme } from '../../../../components/theme.js';
import { glyph } from '../../../../lib/glyphs.js';
import { configStore } from '../../../../stores/project/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { deriveSummaryView } from '../view-model.js';
import { filesSectionRows } from './files.js';

const originalForceHyperlink = process.env['FORCE_HYPERLINK'];

function renderFiles(summary: Summary, width: number) {
  const view = deriveSummaryView({
    record: makeRunRecord({
      ref: { projectDir: '/tmp/closed-rows', sessionId: 'files-session' },
      summary,
      status: { kind: 'closed', as: 'ended' },
    }),
  });
  if (view === null) throw new Error('expected a closed run to have a view');
  const rows = filesSectionRows({ view, width, theme: terminalTheme });
  return renderFeature(
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>,
    { cols: width, rows: 20 },
  );
}

const changed = makeSummary({
  totalTasks: 1,
  changedFiles: ['src/routes/signup.ts', 'src/validate.ts'],
  stoppedAt: { taskId: taskId('T001'), partialFiles: ['src/routes/signup.ts'] },
});

describe('filesSectionRows', () => {
  beforeEach(() => {
    resetAllStores();
    configStore.__testReset({ projectDir: '/repo' });
    process.env['FORCE_HYPERLINK'] = '0';
  });

  afterEach(() => {
    resetAllStores();
    if (originalForceHyperlink === undefined) delete process.env['FORCE_HYPERLINK'];
    else process.env['FORCE_HYPERLINK'] = originalForceHyperlink;
  });

  it('heads the set with a labelled rule and marks the files the run only half wrote', () => {
    const ui = renderFiles(changed, 60);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`Files ${glyph('divider')}`);
    expect(frame).toContain('src/routes/signup.ts · partial');
    expect(frame).toContain('src/validate.ts');
    expect(frame.split('\n').find((line) => line.includes('validate.ts'))).not.toContain('partial');

    ui.unmount();
  });

  it('keeps both ends of a path the column cannot seat', () => {
    const ui = renderFiles(
      makeSummary({
        totalTasks: 1,
        changedFiles: ['src/features/summary/components/very-long-file-name-here.tsx'],
      }),
      30,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('src/');
    expect(frame).toContain('.tsx');
    expect(frame).not.toContain('very-long-file-name-here');

    ui.unmount();
  });

  it('wraps a path in OSC 8 only when the terminal says it can follow one', () => {
    process.env['FORCE_HYPERLINK'] = '1';
    const linked = renderFiles(changed, 60);
    expect(linked.lastFrame() ?? '').toContain('\u001b]8;;file:///repo/src/validate.ts');
    linked.unmount();

    process.env['FORCE_HYPERLINK'] = '0';
    const plain = renderFiles(changed, 60);
    expect(plain.lastFrame() ?? '').not.toContain('\u001b]8');
    plain.unmount();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { BRIEF_READINESS_FILE, TASKS_FILE } from '../../../../core/paths.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { PlanReviewHeader } from './header.js';
import { useBriefData } from './use-load-state.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = createTempDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

function writeTasks(dir: string): string {
  const filePath = join(dir, TASKS_FILE);
  writeFileSync(filePath, formatTasks([makeTask({ id: 'T001', title: 'Blocked brief' })]), 'utf8');
  return filePath;
}

function writeBlockingReadiness(dir: string): void {
  writeFileSync(
    join(dir, BRIEF_READINESS_FILE),
    JSON.stringify({
      ok: false,
      metadata: [],
      blocks: [
        {
          taskId: 'T001',
          kind: 'overflow',
          message: 'Task T001 overflows the selected worker context',
          nextAction: 'split the task or route it to a larger worker',
        },
      ],
    }),
    'utf8',
  );
}

function Harness({ filePath }: { filePath: string }) {
  const { tasks, quality, readiness } = useBriefData(filePath);
  const loadError = reviewStore.use((state) => state.loadError);
  return (
    <Box flexDirection="column">
      <PlanReviewHeader
        tasks={tasks}
        quality={quality}
        readiness={readiness}
        filePath={filePath}
        width={100}
        hasLoadError={loadError !== null}
      />
      <Text>{loadError === null ? 'load: ok' : 'load: failed'}</Text>
    </Box>
  );
}

describe('useBriefData', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
    for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
  });

  it('carries the loaded readiness report to the header', async () => {
    const dir = tempDir('brief-data-report');
    const filePath = writeTasks(dir);
    writeBlockingReadiness(dir);

    const ui = renderFeature(<Harness filePath={filePath} />);
    try {
      await vi.waitFor(() => {
        const frame = stripAnsiStyles(ui.lastFrame());
        expect(frame).toContain('readiness 1 blocked');
        expect(frame).toContain('approve again overrides');
        expect(frame).toContain('load: ok');
      });
    } finally {
      ui.unmount();
    }
  });

  itUnix('reports a link-attacked brief artifact as a load error, claiming no blocks', async () => {
    const dir = tempDir('brief-data-linked-brief');
    const outside = tempDir('brief-data-outside-brief');
    writeTasks(outside);
    writeBlockingReadiness(dir);
    const filePath = join(dir, TASKS_FILE);
    symlinkSync(join(outside, TASKS_FILE), filePath);

    const ui = renderFeature(<Harness filePath={filePath} />);
    try {
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui.lastFrame())).toContain('load: failed');
      });
      const frame = stripAnsiStyles(ui.lastFrame());
      expect(frame).not.toContain('blocked');
      expect(frame).not.toContain('approve again overrides');
    } finally {
      ui.unmount();
    }
  });

  itUnix(
    'reports a link-attacked readiness artifact as a load error, claiming no blocks',
    async () => {
      const dir = tempDir('brief-data-linked-report');
      const outside = tempDir('brief-data-outside-report');
      writeBlockingReadiness(outside);
      const filePath = writeTasks(dir);
      symlinkSync(join(outside, BRIEF_READINESS_FILE), join(dir, BRIEF_READINESS_FILE));

      const ui = renderFeature(<Harness filePath={filePath} />);
      try {
        await vi.waitFor(() => {
          expect(stripAnsiStyles(ui.lastFrame())).toContain('load: failed');
        });
        const frame = stripAnsiStyles(ui.lastFrame());
        expect(frame).not.toContain('blocked');
        expect(frame).not.toContain('approve again overrides');
      } finally {
        ui.unmount();
      }
    },
  );
});

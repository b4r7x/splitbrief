import { describe, it, expect, afterEach } from 'vitest';
import {
  writeSpecFile,
  readSpecFile,
  buildSpecFrontmatter,
  type SpecMetadata,
} from '../../../src/core/paths-io.js';
import { TASKS_FILE } from '../../../src/core/paths.js';
import { formatTasks } from '../../../src/engine/spec/formatter.js';
import { parseTasksStrict } from '../../../src/engine/spec/tasks/parse.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';

const meta: SpecMetadata = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
};

function makeTmp(): string {
  tmp = createTempDir('spec-file-provenance-test');
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function provenanceTask() {
  return makeTask({
    title: 'Create thing',
    file: 'src/thing.ts',
    description: 'Make the thing.',
    tests: ['it works'],
    implementationSteps: ['write it'],
  });
}

describe('tasks.md spec-file provenance', () => {
  it('prepends provenance frontmatter to tasks.md even though formatTasks output starts with a task block', () => {
    const dir = makeTmp();
    const task = provenanceTask();
    const formatted = formatTasks([task]);
    expect(formatted.startsWith('---\nid:')).toBe(true);

    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, TASKS_FILE, formatted, meta);
    const content = readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, TASKS_FILE);
    if (content === null) throw new Error('expected tasks file to be present');
    expect(content.startsWith('---\ngenerated_by: diptych v')).toBe(true);
    expect(content).toContain('planner: claude-code');
    expect(content).toContain('id: T001');

    const parsed = parseTasksStrict(content);
    expect(parsed.map((t) => t.id)).toEqual([task.id]);
  });

  it('does not double-prepend provenance when tasks.md already carries file frontmatter', () => {
    const dir = makeTmp();
    const task = provenanceTask();
    const withProvenance = buildSpecFrontmatter(meta) + formatTasks([task]);
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, TASKS_FILE, withProvenance, meta);
    const content = readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, TASKS_FILE);
    if (content === null) throw new Error('expected tasks file to be present');
    const fmCount = (content.match(/generated_by:/g) ?? []).length;
    expect(fmCount).toBe(1);
  });
});

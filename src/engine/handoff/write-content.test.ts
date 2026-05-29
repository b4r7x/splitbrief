import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { writeHandoffPack } from './write.js';
import { hashTaskBrief } from '../brief-hash.js';
import { DIPTYCH_DIR, STATE_FILE } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';

let tmp: string;

const t1 = makeTask({
  id: 'T001',
  title: 'Add auth middleware',
  action: 'create',
  file: 'src/middleware/auth.ts',
  dependsOn: [],
  description: 'Create an authentication middleware that validates JWT tokens.',
  tests: ['returns 401 for missing token', 'returns 403 for expired token'],
  constraints: ['must not introduce new dependencies'],
  implementationSteps: ['Parse Authorization header', 'Validate JWT'],
  typeDefs: 'function authMiddleware(req: Request, res: Response): void',
  status: 'pending',
});

const t2 = makeTask({
  id: 'T002',
  title: 'Add user model',
  action: 'modify',
  file: 'src/models/user.ts',
  dependsOn: ['T001'],
  description: 'Extend the user model with role field.',
  tests: ['role field defaults to user'],
  constraints: ['must not break existing schema'],
  implementationSteps: ['Add role field to schema'],
  typeDefs: "type UserRole = 'user' | 'admin'",
  status: 'pending',
});

const t3 = makeTask({
  id: 'T003',
  title: 'Write integration tests',
  action: 'create',
  file: 'src/middleware/auth.test.ts',
  dependsOn: ['T001', 'T002'],
  description: 'Write integration tests for the auth middleware.',
  tests: ['all three test cases pass'],
  constraints: ['use vitest'],
  implementationSteps: ['Import authMiddleware', 'Mock JWT'],
  typeDefs: '',
  status: 'pending',
});

function writeSessionState(projectDir: string, sessionId: string): void {
  const sessionDir = join(projectDir, DIPTYCH_DIR, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const state = {
    ...createInitialState('Authentication System'),
    stateVersion: CURRENT_STATE_VERSION,
    tasks: [t1, t2, t3],
    phase: 'implementing' as const,
  };
  writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state));
}

beforeEach(() => {
  tmp = createTempDir('write-handoff-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('writeHandoffPack — validation metadata', () => {
  it('includes enabled typecheck, lint, and test commands in manifest.json', async () => {
    const sessionId = 'validation-session';
    writeSessionState(tmp, sessionId);
    mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
    writeFileSync(
      join(tmp, DIPTYCH_DIR, 'config.yaml'),
      [
        'version: 3',
        'validation:',
        '  typecheck: true',
        '  lint: true',
        '  test: true',
        '  test_command: npm run test:unit',
      ].join('\n'),
    );

    const outDir = join(tmp, 'handoff', 'validation');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));

    expect(manifest.validation).toEqual({
      typecheck: 'npm run typecheck',
      lint: 'npm run lint',
      test: 'npm run test:unit',
    });
  });
});

describe('writeHandoffPack — readback correctness', () => {
  it('produces task files with real briefHash matching manifest, correct taskId, and non-empty sections', async () => {
    const sessionId = 'readback-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'readback');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    const expectedHash = hashTaskBrief([t1, t2, t3]);

    // Manifest briefHash is a 64-char hex string matching the expected hash
    expect(manifest.briefHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.briefHash).toBe(expectedHash);

    // Read back each task file and verify content
    for (const tid of ['T001', 'T002', 'T003']) {
      const content = readFileSync(join(outDir, 'tasks', `${tid}.md`), 'utf-8');

      // No <placeholder> anywhere in the file
      expect(content).not.toContain('<placeholder>');

      // Frontmatter briefHash matches manifest
      const hashMatch = content.match(/^briefHash:\s*(.+)$/m);
      expect(hashMatch).not.toBeNull();
      expect(hashMatch![1]!.trim()).toBe(manifest.briefHash);

      // Frontmatter taskId matches expected
      const taskIdMatch = content.match(/^taskId:\s*(.+)$/m);
      expect(taskIdMatch).not.toBeNull();
      expect(taskIdMatch![1]!.trim()).toBe(tid);
      expect(manifest.taskIds).toContain(tid);

      // Structural markers exist
      expect(content).toContain(`# ${tid} —`);
      expect(content).toContain('## Intent');
      expect(content).toContain('## Implementation Steps');

      // Intent section has actual content
      const intentMatch = content.match(/## Intent\n+(.+)/);
      expect(intentMatch).not.toBeNull();
      expect(intentMatch![1]!.trim().length).toBeGreaterThan(0);

      // Implementation Steps section has actual content
      const stepsMatch = content.match(/## Implementation Steps\n+(.+)/);
      expect(stepsMatch).not.toBeNull();
      expect(stepsMatch![1]!.trim().length).toBeGreaterThan(0);
    }
  });
});

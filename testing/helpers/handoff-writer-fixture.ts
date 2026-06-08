import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIPTYCH_DIR, STATE_FILE } from '../../src/core/paths.js';
import { createInitialState, CURRENT_STATE_VERSION } from '../../src/core/state/machine.js';
import type { Task } from '../../src/core/schemas/task.js';
import { makeTask } from './factories/task.js';

export const handoffWriterTasks: Task[] = [
  makeTask({
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
  }),
  makeTask({
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
  }),
  makeTask({
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
  }),
];

export function writeHandoffWriterSessionState(projectDir: string, sessionId: string): void {
  const sessionDir = join(projectDir, DIPTYCH_DIR, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const state = {
    ...createInitialState('Authentication System'),
    stateVersion: CURRENT_STATE_VERSION,
    tasks: handoffWriterTasks,
    phase: 'implementing' as const,
  };
  writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state));
}

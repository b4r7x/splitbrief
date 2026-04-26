import { describe, it, expect } from 'vitest';
import { renderHandoff } from './render.js';
import type { HandoffInput, HandoffTarget } from './types.js';
import { makeTask } from '../../../testing/helpers/factories/task.js';

const t1 = makeTask({
  id: 'T001',
  title: 'Add auth middleware',
  action: 'create',
  file: 'src/middleware/auth.ts',
  dependsOn: [],
  description: 'Create an authentication middleware that validates JWT tokens.',
  tests: ['returns 401 for missing token', 'returns 403 for expired token', 'calls next() for valid token'],
  constraints: ['must not introduce new dependencies', 'must preserve existing routes'],
  implementationSteps: ['Parse Authorization header', 'Validate JWT', 'Attach user to context'],
  typeDefs: 'function authMiddleware(req: Request, res: Response, next: NextFunction): void',
  signature: 'authMiddleware(req, res, next)',
  pattern: 'express middleware pattern',
  scope: {
    inBounds: ['src/middleware/auth.ts'],
    outOfBounds: ['src/routes/', 'src/models/'],
  },
  escalation: ['stop if token library is missing'],
  evidence: ['auth middleware test passes', 'existing routes unaffected'],
  status: 'pending',
});

const t2 = makeTask({
  id: 'T002',
  title: 'Add user model',
  action: 'modify',
  file: 'src/models/user.ts',
  dependsOn: ['T001'],
  description: 'Extend the user model with role field.',
  tests: ['role field defaults to user', 'admin role accepted'],
  constraints: ['must not break existing schema'],
  implementationSteps: ['Add role field to schema', 'Update type exports'],
  typeDefs: "type UserRole = 'user' | 'admin'",
  currentCode: "export type User = { id: string; name: string; }",
  status: 'pending',
});

const t3 = makeTask({
  id: 'T003',
  title: 'Write integration tests',
  action: 'create',
  file: 'src/middleware/auth.test.ts',
  dependsOn: ['T001', 'T002'],
  description: 'Write integration tests for the auth middleware.',
  tests: ['all three test cases pass', 'coverage above 90%'],
  constraints: ['use vitest'],
  implementationSteps: ['Import authMiddleware', 'Mock JWT', 'Assert responses'],
  typeDefs: '',
  status: 'pending',
});

const baseInput: HandoffInput = {
  target: 'spec-kit',
  sessionId: 'sess-abc',
  feature: 'Authentication System',
  mode: 'standard',
  tasks: [t1, t2, t3],
  spec: '# Spec\nAuthentication system spec.',
  plan: '# Plan\nImplementation plan.',
  constitution: '# Constitution\nProject rules.',
  validation: {
    typecheck: 'npm run typecheck',
    lint: 'npm run lint',
    test: 'npm test',
  },
};

describe('renderHandoff — spec-kit', () => {
  it('includes tasks/T001.md with all nine brief sections', () => {
    const pack = renderHandoff({ ...baseInput, target: 'spec-kit' });
    const file = pack.files.find(f => f.path === 'tasks/T001.md');
    expect(file).toBeDefined();
    const c = file!.content;
    expect(c).toContain('briefHash: <placeholder>');
    expect(c).toContain('taskId: T001');
    expect(c).toContain('## Intent');
    expect(c).toContain('## Scope');
    expect(c).toContain('## Code Context');
    expect(c).toContain('## Implementation Steps');
    expect(c).toContain('## Validation');
    expect(c).toContain('## Constraints');
    expect(c).toContain('## Escalation');
    expect(c).toContain('## Evidence');
  });

  it('includes spec.md and plan.md when provided', () => {
    const pack = renderHandoff({ ...baseInput, target: 'spec-kit' });
    const paths = pack.files.map(f => f.path);
    expect(paths).toContain('spec.md');
    expect(paths).toContain('plan.md');
  });

  it('omits spec.md and plan.md when not provided', () => {
    const { spec: _s, plan: _p, ...withoutSpecPlan } = baseInput;
    const pack = renderHandoff({ ...withoutSpecPlan, target: 'spec-kit' });
    const paths = pack.files.map(f => f.path);
    expect(paths).not.toContain('spec.md');
    expect(paths).not.toContain('plan.md');
  });

  it('includes constitution.md when provided', () => {
    const pack = renderHandoff({ ...baseInput, target: 'spec-kit' });
    const paths = pack.files.map(f => f.path);
    expect(paths).toContain('constitution.md');
  });
});

describe('renderHandoff — agents-md', () => {
  it('includes AGENTS.md with task links', () => {
    const pack = renderHandoff({ ...baseInput, target: 'agents-md' });
    const file = pack.files.find(f => f.path === 'AGENTS.md');
    expect(file).toBeDefined();
    const c = file!.content;
    expect(c).toContain('[T001](tasks/T001.md)');
    expect(c).toContain('[T002](tasks/T002.md)');
    expect(c).toContain('[T003](tasks/T003.md)');
    expect(c).toContain('Add auth middleware');
  });

  it('also includes the base task files', () => {
    const pack = renderHandoff({ ...baseInput, target: 'agents-md' });
    const paths = pack.files.map(f => f.path);
    expect(paths).toContain('tasks/T001.md');
    expect(paths).toContain('README.md');
  });
});

describe('renderHandoff — claude-code', () => {
  it('includes CLAUDE.md', () => {
    const pack = renderHandoff({ ...baseInput, target: 'claude-code' });
    const file = pack.files.find(f => f.path === 'CLAUDE.md');
    expect(file).toBeDefined();
    expect(file!.content).toContain('[T001](tasks/T001.md)');
    expect(file!.content).toContain('Do not stage or commit');
  });

  it('includes .claude/agents/diptych-handoff.md', () => {
    const pack = renderHandoff({ ...baseInput, target: 'claude-code' });
    const file = pack.files.find(f => f.path === '.claude/agents/diptych-handoff.md');
    expect(file).toBeDefined();
    expect(file!.content).toContain('diptych-handoff');
    expect(file!.content).toContain('Do NOT stage or commit');
    expect(file!.content).toContain('typecheck');
  });
});

describe('renderHandoff — copilot-issue', () => {
  it('produces exactly issue.md with all required sections', () => {
    const pack = renderHandoff({ ...baseInput, target: 'copilot-issue' });
    expect(pack.files).toHaveLength(1);
    const [issueFile] = pack.files;
    expect(issueFile?.path).toBe('issue.md');
    const c = issueFile?.content ?? '';
    expect(c).toContain('## Summary');
    expect(c).toContain('## Tasks');
    expect(c).toContain('## Acceptance Criteria');
    expect(c).toContain('## Constraints');
    expect(c).toContain('## Validation');
    expect(c).toContain('## Do not');
    expect(c).toContain('Authentication System');
  });

  it('flattens tests and constraints across all tasks', () => {
    const pack = renderHandoff({ ...baseInput, target: 'copilot-issue' });
    const [issueFile] = pack.files;
    const c = issueFile?.content ?? '';
    expect(c).toContain('returns 401 for missing token');
    expect(c).toContain('role field defaults to user');
    expect(c).toContain('must not introduce new dependencies');
  });

  it('includes validation commands', () => {
    const pack = renderHandoff({ ...baseInput, target: 'copilot-issue' });
    const [issueFile] = pack.files;
    const c = issueFile?.content ?? '';
    expect(c).toContain('npm run typecheck');
    expect(c).toContain('npm run lint');
    expect(c).toContain('npm test');
  });
});

describe('renderHandoff — selectedTaskIds', () => {
  it('filters to only requested task', () => {
    const pack = renderHandoff({ ...baseInput, target: 'spec-kit', selectedTaskIds: [t1.id] });
    const taskFiles = pack.files.filter(f => f.path.startsWith('tasks/'));
    expect(taskFiles).toHaveLength(1);
    const [firstTaskFile] = taskFiles;
    expect(firstTaskFile?.path).toBe('tasks/T001.md');
  });

  it('other tasks do not appear in tasks/ when filtered', () => {
    const pack = renderHandoff({ ...baseInput, target: 'spec-kit', selectedTaskIds: [t1.id] });
    const paths = pack.files.map(f => f.path);
    expect(paths).not.toContain('tasks/T002.md');
    expect(paths).not.toContain('tasks/T003.md');
  });

  it('throws with task id in message for unknown selectedTaskId', () => {
    expect(() =>
      renderHandoff({ ...baseInput, selectedTaskIds: ['T999' as typeof t1.id] })
    ).toThrow('unknown task id: T999');
  });
});

describe('renderHandoff — unsupported target', () => {
  it('throws with target name in message', () => {
    expect(() =>
      renderHandoff({ ...baseInput, target: 'foobar' as HandoffTarget })
    ).toThrow('unsupported target: foobar');
  });
});

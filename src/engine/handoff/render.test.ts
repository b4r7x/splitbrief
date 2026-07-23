import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderHandoff, renderHandoffWithCustom } from './render.js';
import type { HandoffInput } from './types.js';
import type { HandoffTarget } from '../../core/handoff/targets.js';
import { HANDOFF_TARGETS } from '../../core/handoff/targets.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const t1 = makeTask({
  id: 'T001',
  title: 'Add auth middleware',
  action: 'create',
  file: 'src/middleware/auth.ts',
  dependsOn: [],
  description: 'Create an authentication middleware that validates JWT tokens.',
  tests: [
    'returns 401 for missing token',
    'returns 403 for expired token',
    'calls next() for valid token',
  ],
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
  currentCode: 'export type User = { id: string; name: string; }',
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
    const file = pack.files.find((f) => f.path === 'tasks/T001.md');
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
    const paths = pack.files.map((f) => f.path);
    expect(paths).toContain('spec.md');
    expect(paths).toContain('plan.md');
  });

  it('omits spec.md and plan.md when not provided', () => {
    const { spec: _s, plan: _p, ...withoutSpecPlan } = baseInput;
    const pack = renderHandoff({ ...withoutSpecPlan, target: 'spec-kit' });
    const paths = pack.files.map((f) => f.path);
    expect(paths).not.toContain('spec.md');
    expect(paths).not.toContain('plan.md');
  });

  it('includes constitution.md when provided', () => {
    const pack = renderHandoff({ ...baseInput, target: 'spec-kit' });
    const paths = pack.files.map((f) => f.path);
    expect(paths).toContain('constitution.md');
  });
});

describe('renderHandoff — agents-md', () => {
  it('includes AGENTS.md with task links', () => {
    const pack = renderHandoff({ ...baseInput, target: 'agents-md' });
    const file = pack.files.find((f) => f.path === 'AGENTS.md');
    expect(file).toBeDefined();
    const c = file!.content;
    expect(c).toContain('[T001](tasks/T001.md)');
    expect(c).toContain('[T002](tasks/T002.md)');
    expect(c).toContain('[T003](tasks/T003.md)');
    expect(c).toContain('Add auth middleware');
  });

  it('also includes the base task files', () => {
    const pack = renderHandoff({ ...baseInput, target: 'agents-md' });
    const paths = pack.files.map((f) => f.path);
    expect(paths).toContain('tasks/T001.md');
    expect(paths).toContain('README.md');
  });
});

describe('renderHandoff — claude-code', () => {
  it('includes CLAUDE.md', () => {
    const pack = renderHandoff({ ...baseInput, target: 'claude-code' });
    const file = pack.files.find((f) => f.path === 'CLAUDE.md');
    expect(file).toBeDefined();
    expect(file!.content).toContain('[T001](tasks/T001.md)');
    expect(file!.content).toContain('Do not stage or commit');
  });

  it('includes .claude/agents/diptych-handoff.md', () => {
    const pack = renderHandoff({ ...baseInput, target: 'claude-code' });
    const file = pack.files.find((f) => f.path === '.claude/agents/diptych-handoff.md');
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
    expect(c).not.toContain('tasks/T001.md');
    expect(c).toContain('**T001**');
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
  it('filters task artifacts to the requested ids', () => {
    const pack = renderHandoff({ ...baseInput, target: 'spec-kit', selectedTaskIds: [t1.id] });
    const taskFiles = pack.files.filter((f) => f.path.startsWith('tasks/'));
    expect(taskFiles).toHaveLength(1);
    const [firstTaskFile] = taskFiles;
    expect(firstTaskFile?.path).toBe('tasks/T001.md');
    const paths = pack.files.map((f) => f.path);
    expect(paths).not.toContain('tasks/T002.md');
    expect(paths).not.toContain('tasks/T003.md');
  });

  it('throws with task id in message for unknown selectedTaskId', () => {
    expect(() =>
      renderHandoff({ ...baseInput, selectedTaskIds: ['T999' as typeof t1.id] }),
    ).toThrow('unknown task id: T999');
  });
});

describe('renderHandoff — unsupported target', () => {
  it('throws with target name in message', () => {
    expect(() => renderHandoff({ ...baseInput, target: 'foobar' as HandoffTarget })).toThrow(
      'unsupported target: foobar',
    );
  });
});

const customRendererBaseInput: Omit<HandoffInput, 'target'> & { target: string } = {
  target: 'spec-kit',
  sessionId: 'sess-test',
  feature: 'Test Feature',
  mode: 'standard',
  tasks: [t1],
};

let customRendererTmp: string;

beforeEach(() => {
  customRendererTmp = mkdtempSync(join(tmpdir(), 'render-handoff-custom-'));
  writeFileSync(join(customRendererTmp, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterEach(() => {
  rmSync(customRendererTmp, { recursive: true, force: true });
});

describe('renderHandoffWithCustom', () => {
  it.each(
    HANDOFF_TARGETS,
  )('renders built-in target %s without loading a custom file', async (target) => {
    const pack = await renderHandoffWithCustom(
      { ...customRendererBaseInput, target },
      customRendererTmp,
      { trustCustomRenderers: false },
    );
    expect(pack.files.length).toBeGreaterThan(0);
  });

  it('delegates to sync renderHandoff for built-in targets without loading a file', async () => {
    const pack = await renderHandoffWithCustom(
      { ...customRendererBaseInput, target: 'spec-kit' },
      customRendererTmp,
    );
    expect(pack.files.length).toBeGreaterThan(0);
    expect(pack.files.some((f) => f.path.startsWith('tasks/'))).toBe(true);
  });

  it('loads and calls a custom renderer for an unknown target when trusted', async () => {
    const renderersDir = join(customRendererTmp, '.diptych', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(
      join(renderersDir, 'my-custom.js'),
      `export default async function render(input) {
        return { files: [{ path: 'custom.md', content: 'from custom renderer' }] };
      }`,
    );

    const pack = await renderHandoffWithCustom(
      { ...customRendererBaseInput, target: 'my-custom' },
      customRendererTmp,
      { trustCustomRenderers: true },
    );
    expect(pack.files).toHaveLength(1);
    expect(pack.files[0]?.path).toBe('custom.md');
    expect(pack.files[0]?.content).toBe('from custom renderer');
  });

  it('blocks custom renderer when not trusted', async () => {
    const renderersDir = join(customRendererTmp, '.diptych', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(
      join(renderersDir, 'my-custom.js'),
      `export default async function render(input) {
        return { files: [{ path: 'custom.md', content: 'from custom renderer' }] };
      }`,
    );

    await expect(
      renderHandoffWithCustom(
        { ...customRendererBaseInput, target: 'my-custom' },
        customRendererTmp,
      ),
    ).rejects.toThrow(/blocked.*trust\.customRenderers/);
  });

  it('throws with "unknown target" message when no built-in or custom renderer found', async () => {
    await expect(
      renderHandoffWithCustom(
        { ...customRendererBaseInput, target: 'no-such-renderer' },
        customRendererTmp,
        {
          trustCustomRenderers: true,
        },
      ),
    ).rejects.toThrow('unknown target: no-such-renderer. No built-in or custom renderer found.');
  });
});

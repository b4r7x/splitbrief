import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIPTYCH_DIR, EVIDENCE_FILE, SESSIONS_DIR } from '../../../core/paths.js';
import { EvidenceLedgerSchema } from '../../../core/schemas/evidence.js';
import { taskId } from '../../../core/schemas/task.js';
import { createEvidenceLedger } from '../../orchestrator/evidence/ledger.js';
import { writeEvidenceLedger } from '../../orchestrator/evidence/persistence.js';
import { createToolHandler } from './handler.js';
import type { ToolCallResult } from '../types.js';

type ParsedLedger = ReturnType<typeof EvidenceLedgerSchema.parse>;
type ParsedTask = ParsedLedger['tasks'][number];

function createTestProject(): { projectDir: string; cleanup: () => void } {
  const projectDir = mkdtempSync(join(tmpdir(), 'mcp-tools-test-'));
  return {
    projectDir,
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

function seedSession(projectDir: string, sessionId: string): void {
  const sessDir = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  mkdirSync(sessDir, { recursive: true });
  const ledger = createEvidenceLedger({
    sessionId,
    feature: 'test feature',
    tasks: [
      {
        id: taskId('T001'),
        title: 'First task',
        action: 'modify',
        file: 'src/foo.ts',
        dependsOn: [],
        description: 'Do the thing',
        tests: ['it works'],
        constraints: [],
        typeDefs: '',
        implementationSteps: ['step 1'],
        status: 'in_progress',
      },
      {
        id: taskId('T002'),
        title: 'Second task',
        action: 'create',
        file: 'src/bar.ts',
        dependsOn: [taskId('T001')],
        description: 'Do another thing',
        tests: [],
        constraints: [],
        typeDefs: '',
        implementationSteps: [],
        status: 'pending',
      },
    ],
  });
  writeEvidenceLedger(projectDir, sessionId, ledger);
}

function readLedger(projectDir: string, sessionId: string): ParsedLedger {
  const path = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId, EVIDENCE_FILE);
  return EvidenceLedgerSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

function findTask(ledger: ParsedLedger, id: string): ParsedTask {
  const task = ledger.tasks.find(t => t.id === id);
  if (task === undefined) {
    throw new Error(`Expected task ${id} to exist`);
  }
  return task;
}

function expectToolError(result: ToolCallResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected tool call to fail');
  }
  return result.error;
}

describe('MCP tool handler', () => {
  let projectDir: string;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    const result = createTestProject();
    projectDir = result.projectDir;
    cleanup = result.cleanup;
    seedSession(projectDir, 'sess-001');
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('listTools returns all 5 tool definitions', () => {
    const handler = createToolHandler(projectDir);
    const tools = handler.listTools();
    expect(tools).toHaveLength(5);
    const names = tools.map(t => t.name);
    expect(names).toContain('report_evidence');
    expect(names).toContain('report_progress');
    expect(names).toContain('mark_task_done');
    expect(names).toContain('report_validation_result');
    expect(names).toContain('report_error');
  });

  it('report_evidence appends observed evidence and changed files to evidence ledger', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: ['component renders correctly', 'no console errors'],
      changedFiles: ['src/foo.ts', 'src/foo.test.ts'],
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = findTask(ledger, 'T001');
    expect(task.observedEvidence).toContain('component renders correctly');
    expect(task.observedEvidence).toContain('no console errors');
    expect(task.changedFiles).toContain('src/foo.ts');
    expect(task.changedFiles).toContain('src/foo.test.ts');
  });

  it('report_evidence rejects invalid input', () => {
    const handler = createToolHandler(projectDir);
    const before = readLedger(projectDir, 'sess-001');
    const result = handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: [],
    });
    expectToolError(result);
    expect(readLedger(projectDir, 'sess-001')).toEqual(before);
  });

  it('report_evidence rejects nonexistent session', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_evidence', {
      sessionId: 'nonexistent',
      taskId: 'T001',
      observedEvidence: ['test'],
    });
    const error = expectToolError(result);
    expect(error).toContain('Session not found');
  });

  it('report_evidence rejects nonexistent task', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T999',
      observedEvidence: ['test'],
    });
    const error = expectToolError(result);
    expect(error).toContain('Task not found');
  });

  it('report_evidence rejects traversal session id without writing outside sessions', () => {
    const handler = createToolHandler(projectDir);
    const before = readLedger(projectDir, 'sess-001');
    const escapedEvidencePath = join(projectDir, DIPTYCH_DIR, 'escape', EVIDENCE_FILE);
    const result = handler.callTool('report_evidence', {
      sessionId: '../escape',
      taskId: 'T001',
      observedEvidence: ['escaped write'],
    });
    const error = expectToolError(result);
    expect(error.length).toBeGreaterThan(0);
    expect(existsSync(escapedEvidencePath)).toBe(false);
    expect(readLedger(projectDir, 'sess-001')).toEqual(before);
  });

  it('report_progress records progress message as observed evidence', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_progress', {
      sessionId: 'sess-001',
      taskId: 'T001',
      message: 'Implementing auth flow',
      percentComplete: 60,
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = findTask(ledger, 'T001');
    expect(task.observedEvidence).toContain('progress: Implementing auth flow (60%)');
  });

  it('mark_task_done sets status, method, changed files, and evidence', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('mark_task_done', {
      sessionId: 'sess-001',
      taskId: 'T001',
      changedFiles: ['src/foo.ts'],
      observedEvidence: ['all tests pass'],
      summary: 'Refactored auth module',
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = findTask(ledger, 'T001');
    expect(task.status).toBe('done');
    expect(task.method).toBe('mcp-tool');
    expect(task.changedFiles).toContain('src/foo.ts');
    expect(task.observedEvidence).toContain('task reached done');
    expect(task.observedEvidence).toContain('summary: Refactored auth module');
    expect(task.observedEvidence).toContain('all tests pass');
    expect(ledger.validationSummary.passed).toBeGreaterThanOrEqual(1);
  });

  it('report_validation_result appends validation entry to task', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_validation_result', {
      sessionId: 'sess-001',
      taskId: 'T001',
      stage: 'typecheck',
      passed: true,
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = findTask(ledger, 'T001');
    expect(task.validation).toHaveLength(1);
    expect(task.validation.at(0)).toMatchObject({ stage: 'typecheck', passed: true });
    expect(task.observedEvidence).toContain('typecheck passed');
  });

  it('report_validation_result records failed validation with error summary', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_validation_result', {
      sessionId: 'sess-001',
      taskId: 'T001',
      stage: 'test',
      passed: false,
      errorSummary: 'TypeError: Cannot read properties of undefined',
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = findTask(ledger, 'T001');
    expect(task.validation.at(0)).toMatchObject({
      stage: 'test',
      passed: false,
      errorSummary: 'TypeError: Cannot read properties of undefined',
    });
  });

  it('report_error marks task failed and records error in evidence', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_error', {
      sessionId: 'sess-001',
      taskId: 'T001',
      error: 'Module not found: @missing/dep',
      changedFiles: ['src/foo.ts'],
      recoverable: false,
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = findTask(ledger, 'T001');
    expect(task.status).toBe('failed');
    expect(task.observedEvidence).toContain('error: Module not found: @missing/dep');
    expect(task.observedEvidence).toContain('agent reports: unrecoverable');
    expect(task.changedFiles).toContain('src/foo.ts');
    expect(ledger.validationSummary.failed).toBeGreaterThanOrEqual(1);
  });

  it('unknown tool name returns error', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('nonexistent_tool', {});
    const error = expectToolError(result);
    expect(error).toContain('Unknown tool');
  });

  it('multiple evidence reports for the same task accumulate without duplicates', () => {
    const handler = createToolHandler(projectDir);
    handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: ['check A'],
    });
    handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: ['check A', 'check B'],
    });

    const ledger = readLedger(projectDir, 'sess-001');
    const task = findTask(ledger, 'T001');
    const checkACount = task.observedEvidence.filter(e => e === 'check A').length;
    expect(checkACount).toBe(1);
    expect(task.observedEvidence).toContain('check B');
  });
});

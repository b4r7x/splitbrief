import type { McpToolDefinition, McpToolHandler, ToolCallResult } from '../types.js';
import {
  handleReportEvidence,
  handleReportProgress,
  handleMarkTaskDone,
  handleReportValidationResult,
  handleReportError,
} from './operations.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'report_evidence',
    description:
      'Report observed evidence for a task. Call after completing a verification step (e.g. manual check, code review, or any non-automated validation).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: `Active ${SPLITBRIEF_IDENTITY.displayName} session ID`,
        },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        observedEvidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of observed evidence statements',
          minItems: 1,
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project-relative file paths touched',
        },
      },
      required: ['sessionId', 'taskId', 'observedEvidence'],
    },
  },
  {
    name: 'report_progress',
    description: `Report progress on a task. Call periodically during long-running implementations to update ${SPLITBRIEF_IDENTITY.displayName} on status.`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: `Active ${SPLITBRIEF_IDENTITY.displayName} session ID`,
        },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        message: { type: 'string', description: 'Progress message' },
        percentComplete: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Optional completion percentage',
        },
      },
      required: ['sessionId', 'taskId', 'message'],
    },
  },
  {
    name: 'mark_task_done',
    description:
      'Mark a task as completed. Call when all implementation and validation for a task are finished. Requires at least one changed file.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: `Active ${SPLITBRIEF_IDENTITY.displayName} session ID`,
        },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project-relative file paths modified by this task',
          minItems: 1,
        },
        observedEvidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional evidence observed during implementation',
        },
        summary: { type: 'string', description: 'Optional short summary of what was done' },
      },
      required: ['sessionId', 'taskId', 'changedFiles'],
    },
  },
  {
    name: 'report_validation_result',
    description:
      'Report a validation result (typecheck, lint, or test) for a task. Call after running each validation stage.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: `Active ${SPLITBRIEF_IDENTITY.displayName} session ID`,
        },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        stage: {
          type: 'string',
          enum: ['typecheck', 'lint', 'test'],
          description: 'Validation stage',
        },
        passed: { type: 'boolean', description: 'Whether validation passed' },
        errorSummary: { type: 'string', description: 'Error summary if validation failed' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files relevant to this validation',
        },
      },
      required: ['sessionId', 'taskId', 'stage', 'passed'],
    },
  },
  {
    name: 'report_error',
    description: `Report an error during task implementation. Call when the agent encounters an unrecoverable error or needs ${SPLITBRIEF_IDENTITY.displayName} to make a recovery decision.`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: `Active ${SPLITBRIEF_IDENTITY.displayName} session ID`,
        },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        error: { type: 'string', description: 'Error description' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files modified before the error occurred',
        },
        recoverable: {
          type: 'boolean',
          description: 'Whether the agent believes a retry might succeed',
        },
      },
      required: ['sessionId', 'taskId', 'error'],
    },
  },
];

export function createToolHandler(
  projectDir: string,
  allowedSessionIds?: readonly string[],
): McpToolHandler {
  return {
    listTools: () => TOOL_DEFINITIONS,
    callTool(name: string, args: Record<string, unknown>): ToolCallResult {
      if (allowedSessionIds !== undefined) {
        const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'] : undefined;
        if (sessionId === undefined || !allowedSessionIds.includes(sessionId)) {
          return { ok: false, error: `Session not allowed: ${sessionId ?? '(missing)'}` };
        }
      }

      switch (name) {
        case 'report_evidence':
          return handleReportEvidence(projectDir, args);
        case 'report_progress':
          return handleReportProgress(projectDir, args);
        case 'mark_task_done':
          return handleMarkTaskDone(projectDir, args);
        case 'report_validation_result':
          return handleReportValidationResult(projectDir, args);
        case 'report_error':
          return handleReportError(projectDir, args);
        default:
          return { ok: false, error: `Unknown tool: ${name}` };
      }
    },
  };
}

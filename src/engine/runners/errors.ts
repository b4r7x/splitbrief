import { error } from '../../utils/error.js';

type Role = 'planner' | 'implementer';

export const runnerConfigError = {
  invalidKind: (kind: string, role: Role) =>
    error('runner-invalid-kind', `Unknown ${role} kind: ${kind}`, { kind, role }),
  kindMismatch: (expected: string, actual: string, role: Role) =>
    error(
      'runner-kind-mismatch',
      `${role.toUpperCase()}_FACTORIES['${expected}']: expected ${role}.kind='${expected}', got '${actual}'`,
      { expected, actual, role },
    ),
  missingToolConfig: (toolName: string, role: Role) =>
    error(
      'runner-missing-tool-config',
      role === 'planner'
        ? `CLI tool '${toolName}' has no planner configuration`
        : `Tool ${toolName} has no implementer buildArgs in CLI_TOOLS`,
      { toolName, role },
    ),
} as const;

import { error } from '../../utils/error.js';

type Role = 'planner' | 'implementer';

export const runnerConfigError = {
  missingToolConfig: (toolName: string, role: Role) =>
    error(
      'runner-missing-tool-config',
      role === 'planner'
        ? `CLI tool '${toolName}' has no planner configuration`
        : `Tool ${toolName} has no implementer buildArgs in CLI_TOOLS`,
      { toolName, role },
    ),
} as const;

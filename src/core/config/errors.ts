import { error, matches } from '../../utils/error.js';

type Role = 'planner' | 'implementer';

export const configError = {
  invalidYaml: (path: string, cause: unknown) =>
    error(
      'config-invalid-yaml',
      `Malformed YAML in ${path} — fix the syntax or delete the file to use defaults.`,
      { path },
      cause,
    ),
  validationFailed: (path: string, issues: string[]) =>
    error('config-validation-failed', issues.join('\n'), { path, issues }),
  loadNotCalled: (operation: string) =>
    error(
      'config-load-not-called',
      `configStore.load must be called before ${operation}`,
      { operation },
    ),
  saveFailed: (path: string, cause: unknown) =>
    error('config-save-failed', `Failed to save config to ${path}`, { path }, cause),
  notAnObject: (context: string) =>
    error('config-not-an-object', `${context} must be an object`, { context }),
  unsupportedVersion: (version: unknown) =>
    error(
      'config-unsupported-version',
      `Unsupported config version: ${String(version)}. Expected 1 or 2.`,
      { version },
    ),
  runnerKindIndeterminate: (role: Role, opts: unknown) =>
    error(
      'config-runner-kind-indeterminate',
      `Cannot infer runner kind for ${role}: need one of 'kind', 'tool', 'apiBase', 'command', or 'existing' to be provided. Got: ${JSON.stringify(opts)}`,
      { role, opts },
    ),
  runnerMissingField: (role: Role, kind: string, field: string) =>
    error(
      'config-runner-missing-field',
      `${role} ${kind} kind requires '${field}' field`,
      { role, kind, field },
    ),
  runnerMissingModel: (role: Role) =>
    error(
      'config-runner-missing-model',
      `${role}: 'model' is required but was not provided.`,
      { role },
    ),
  unknownCliTool: (tool: string, allowed: readonly string[]) =>
    error(
      'config-unknown-cli-tool',
      `Unknown CLI tool: ${tool}. Valid tools: ${allowed.join(', ')}`,
      { tool, allowed },
    ),
  unknownProvider: (provider: string, allowed: readonly string[], role?: Role) =>
    error(
      'config-unknown-provider',
      `${role ? `${role}: ` : ''}Unknown provider '${provider}' requires explicit apiBase. Known providers: ${allowed.join(', ')}`,
      { provider, allowed, role },
    ),
  invalidOverride: (field: string, value: unknown, reason: string) =>
    error(
      'config-invalid-override',
      `Invalid ${field}: ${String(value)}. ${reason}`,
      { field, value, reason },
    ),
  kindMismatch: (role: Role, expectedKind: string) =>
    error(
      'config-kind-mismatch',
      `Expected ${expectedKind} ${role} config`,
      { role, expectedKind },
    ),

  isInvalidYaml: matches('config-invalid-yaml'),
  isValidationFailed: matches('config-validation-failed'),
  isLoadNotCalled: matches('config-load-not-called'),
  isSaveFailed: matches('config-save-failed'),
  isNotAnObject: matches('config-not-an-object'),
  isUnsupportedVersion: matches('config-unsupported-version'),
  isRunnerKindIndeterminate: matches('config-runner-kind-indeterminate'),
  isRunnerMissingField: matches('config-runner-missing-field'),
  isRunnerMissingModel: matches('config-runner-missing-model'),
  isUnknownCliTool: matches('config-unknown-cli-tool'),
  isUnknownProvider: matches('config-unknown-provider'),
  isInvalidOverride: matches('config-invalid-override'),
  isKindMismatch: matches('config-kind-mismatch'),
} as const;

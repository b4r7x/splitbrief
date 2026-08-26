import { error } from '../../utils/error.js';
import { includes, isRecord } from '../../utils/type-guards.js';
import {
  READINESS_DIAGNOSTIC_STATE_IDS,
  type ReadinessDiagnosticStateId,
} from '../schemas/readiness.js';
import type { ActiveRunnerRole } from '../runners/cli-tool-catalog.js';

const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|token|secret|password|credential)/i;
const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';

function redactSensitiveKeys(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return CIRCULAR;

  seen.add(value);

  if (Array.isArray(value)) {
    const redactedArray = value.map((item) => redactSensitiveKeys(item, seen));
    seen.delete(value);
    return redactedArray;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : redactSensitiveKeys(nestedValue, seen);
  }
  seen.delete(value);
  return redacted;
}

function stringifyRedacted(value: unknown): string {
  const json = JSON.stringify(redactSensitiveKeys(value));
  return json ?? String(value);
}

export const configError = {
  invalidYaml: (path: string, cause: unknown) =>
    error(
      'config-invalid-yaml',
      `Malformed YAML in ${path} — fix the syntax or delete the file to use defaults.`,
      { path },
      cause,
    ),
  unreadable: (path: string) =>
    error(
      'config-unreadable',
      `Config file ${path} exists but could not be read — check its permissions or delete it to use defaults.`,
      { path },
    ),
  validationFailed: (
    path: string,
    issues: string[],
    diagnosticStates: readonly ReadinessDiagnosticStateId[] = [],
  ) => error('config-validation-failed', issues.join('\n'), { path, issues, diagnosticStates }),
  loadNotCalled: (operation: string) =>
    error('config-load-not-called', `configStore.load must be called before ${operation}`, {
      operation,
    }),
  saveFailed: (path: string, cause: unknown) =>
    error('config-save-failed', `Failed to save config to ${path}`, { path }, cause),
  notAnObject: (context: string) =>
    error('config-not-an-object', `${context} must be an object`, { context }),
  unsupportedVersion: (version: unknown) =>
    error(
      'config-unsupported-version',
      `Unsupported config version: ${String(version)}. Supported: 3. Run \`splitbrief init --reconfigure\` to write a current config.`,
      { version },
    ),
  runnerKindIndeterminate: (role: ActiveRunnerRole, opts: unknown) =>
    error(
      'config-runner-kind-indeterminate',
      `Cannot infer runner kind for ${role}: need one of 'kind', 'tool', 'apiBase', 'command', or 'existing' to be provided. Got: ${stringifyRedacted(opts)}`,
      { role, opts: redactSensitiveKeys(opts) },
    ),
  runnerMissingField: ({
    role,
    kind,
    field,
  }: {
    role: ActiveRunnerRole;
    kind: string;
    field: string;
  }) =>
    error('config-runner-missing-field', `${role} ${kind} kind requires '${field}' field`, {
      role,
      kind,
      field,
    }),
  runnerMissingModel: (role: ActiveRunnerRole) =>
    error('config-runner-missing-model', `${role}: 'model' is required but was not provided.`, {
      role,
    }),
  unknownCliTool: (tool: string, allowed: readonly string[]) =>
    error(
      'config-unknown-cli-tool',
      `Unknown CLI tool: ${tool}. Valid tools: ${allowed.join(', ')}`,
      { tool, allowed },
    ),
  unknownProvider: (provider: string, allowed: readonly string[], role?: ActiveRunnerRole) =>
    error(
      'config-unknown-provider',
      `${role ? `${role}: ` : ''}Unknown provider '${provider}' requires explicit apiBase. Known providers: ${allowed.join(', ')}`,
      { provider, allowed, role },
    ),
  invalidOverride: (field: string, value: unknown, reason: string) =>
    error('config-invalid-override', `Invalid ${field}: ${String(value)}. ${reason}`, {
      field,
      value,
      reason,
    }),
  reviewerInherited: (path: string) =>
    error(
      'config-reviewer-inherited',
      `Cannot edit ${path}: the review seat inherits the planner; give REVIEW its own tool first.`,
      { path },
    ),
  kindMismatch: (role: ActiveRunnerRole, expectedKind: string) =>
    error('config-kind-mismatch', `Expected ${expectedKind} ${role} config`, {
      role,
      expectedKind,
    }),
  profileNotFound: (defaultName: string) =>
    error(
      'config-profile-not-found',
      `Default implementer profile "${defaultName}" is not defined.`,
      { defaultName },
    ),
} as const;

export function configErrorDiagnosticState(err: unknown): ReadinessDiagnosticStateId | undefined {
  if (!isRecord(err) || !isRecord(err['data'])) return undefined;
  const states = err['data']['diagnosticStates'];
  if (!Array.isArray(states)) return undefined;
  return states.find((state): state is ReadinessDiagnosticStateId =>
    includes(READINESS_DIAGNOSTIC_STATE_IDS, state),
  );
}

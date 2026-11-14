import type { CliPlannerAdapter, CliImplementerAdapter, CliSchemaInput } from '../contract.js';
import { validateCliArgs } from '../validate-args.js';

// `-` is the PROMPT value that both `exec` and `exec resume` document as "read from stdin".
// An omitted PROMPT also reads stdin, but prints `Reading prompt from stdin...` on stderr.
export const CODEX_STDIN_PROMPT = '-';

const CODEX_PROTECTED_FLAGS = new Set([
  '--add-dir',
  '--approve-for-me',
  '--ask-for-approval',
  '--cd',
  '--config',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--ephemeral',
  '--ignore-rules',
  '--ignore-user-config',
  '--json',
  '--model',
  '--output-last-message',
  '--output-schema',
  '--sandbox',
  '--skip-git-repo-check',
  '--yolo',
  '-a',
  '-C',
  '-c',
  '-s',
  'exec',
  'resume',
  'workspace-write',
]);
const CODEX_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-a', '-C', '-c', '-s']);

type CodexPlannerBuildInput = Parameters<CliPlannerAdapter<'codex'>['buildArgs']>[0];
type CodexImplementerBuildInput = Parameters<CliImplementerAdapter<'codex'>['buildArgs']>[0];

export function validateArgs(input: {
  invocationArgs: readonly string[];
  baseArgs: readonly string[];
}) {
  return validateCliArgs({
    ...input,
    protectedFlags: CODEX_PROTECTED_FLAGS,
    protectedShortValueFlags: CODEX_PROTECTED_SHORT_VALUE_FLAGS,
  });
}

// Codex reads the schema only from a file; the adapter declares `schemaFile`, so the planner writes one.
function schemaArgs(schema: CliSchemaInput | undefined): string[] {
  if (schema?.path === undefined) return [];
  return ['--output-schema', schema.path];
}

/**
 * REQ-017 read-only planner vector for Codex 0.147.0. Sandbox and approval are
 * GLOBAL flags in v0.147 and must precede `exec`; `exec resume` does not accept
 * local `--sandbox`/`--ask-for-approval`. --ignore-user-config drops user config;
 * --ignore-rules drops execpolicy .rules files; Codex still reads project AGENTS.md.
 */
export function plannerBaseArgs(input: CodexPlannerBuildInput): string[] {
  if (input.sessionId !== null) {
    return [
      ...(input.effort === undefined ? [] : ['-c', `model_reasoning_effort=${input.effort}`]),
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      'resume',
      ...(input.model === undefined ? [] : ['--model', input.model]),
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      ...schemaArgs(input.schema),
      input.sessionId,
      CODEX_STDIN_PROMPT,
    ];
  }

  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    ...(input.effort === undefined ? [] : ['-c', `model_reasoning_effort=${input.effort}`]),
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    'exec',
    ...(input.imagePaths ?? []).flatMap((path) => ['--image', path]),
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    ...schemaArgs(input.schema),
    '--cd',
    input.projectDir,
    CODEX_STDIN_PROMPT,
  ];
}

/**
 * REQ-048 implementer vector: global workspace-write + never approval inside
 * the disposable staged checkout; no added roots, the reasoning effort as the
 * only config override, exact staged `--cd`.
 */
export function implementerBaseArgs(input: CodexImplementerBuildInput): string[] {
  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    ...(input.effort === undefined ? [] : ['-c', `model_reasoning_effort=${input.effort}`]),
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never',
    'exec',
    ...(input.imagePaths ?? []).flatMap((path) => ['--image', path]),
    '--ignore-user-config',
    '--json',
    '--skip-git-repo-check',
    '--cd',
    input.projectDir,
    CODEX_STDIN_PROMPT,
  ];
}

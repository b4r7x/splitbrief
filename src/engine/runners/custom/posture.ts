import { z } from 'zod';
import {
  NormalizedCustomCommandSchema,
  InlineRunnerCommandSchema,
  CustomCommandIdSchema,
} from '../../../core/config/custom-commands/schema.js';
import type { CustomCommandContract } from '../../../core/config/custom-commands/tuple.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';

export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const CustomRunnerSecurityPostureSchema = z
  .strictObject({
    role: z.enum(['planner', 'implementer']),
    source: z.enum(['configured', 'inline']),
    cwd: z.enum(['disposable-stage', 'project-directory']),
    stage: z.enum(['filtered-disposable-stage', 'none']),
    environmentAccess: z.literal('declared-references-only'),
    filesystem: z.literal('host-user-access'),
    network: z.literal('host-network-access'),
    result: z.enum([
      'parsed-output-only',
      'reviewed-declared-artifact-or-workspace-diff-only',
      'reviewed-diff-only',
      'inline-parsed-output-only',
      'inline-workspace-writes',
    ]),
  })
  .readonly();

export const ConfiguredCustomRunnerSchema = z
  .discriminatedUnion('source', [
    z.strictObject({
      source: z.literal('configured'),
      command: NormalizedCustomCommandSchema,
    }),
    z.strictObject({
      source: z.literal('inline'),
      command: InlineRunnerCommandSchema,
    }),
  ])
  .readonly();

const CustomRunnerAdmissionScopeSchema = z
  .strictObject({
    projectIdentity: DigestSchema,
    definitionId: CustomCommandIdSchema,
    definitionDigest: DigestSchema,
  })
  .readonly();

export type ConfiguredCustomRunner = z.infer<typeof ConfiguredCustomRunnerSchema>;

export type CustomRunnerSecurityPosture = z.infer<typeof CustomRunnerSecurityPostureSchema>;
export type CustomRunnerAdmissionScope = z.infer<typeof CustomRunnerAdmissionScopeSchema>;

const CONFIGURED_RESULT_BY_ROLE_AND_CONTRACT = {
  planner: {
    output: 'parsed-output-only',
    // Saved trust receipts digest this value: renaming it revokes every receipt.
    direct: 'reviewed-declared-artifact-or-workspace-diff-only',
  },
  implementer: {
    output: 'parsed-output-only',
    direct: 'reviewed-diff-only',
  },
} as const;

const INLINE_RESULT_BY_CONTRACT = {
  output: 'inline-parsed-output-only',
  direct: 'inline-workspace-writes',
} as const;

function canonicalPosture(
  input: Readonly<{
    source: CustomRunnerSecurityPosture['source'];
    role: CustomRunnerSecurityPosture['role'];
    contract: CustomCommandContract;
  }>,
): CustomRunnerSecurityPosture {
  const common = {
    role: input.role,
    environmentAccess: 'declared-references-only',
    filesystem: 'host-user-access',
    network: 'host-network-access',
  } as const;
  return input.source === 'configured'
    ? {
        ...common,
        source: 'configured',
        cwd: 'disposable-stage',
        stage: 'filtered-disposable-stage',
        result: CONFIGURED_RESULT_BY_ROLE_AND_CONTRACT[input.role][input.contract],
      }
    : {
        ...common,
        source: 'inline',
        cwd: 'project-directory',
        stage: 'none',
        result: INLINE_RESULT_BY_CONTRACT[input.contract],
      };
}

/** Posture of a `customCommands` entry: staged cwd, declared environment only. */
export function customRunnerSecurityPosture(
  role: CustomRunnerSecurityPosture['role'],
  contract: CustomCommandContract,
): CustomRunnerSecurityPosture {
  return canonicalPosture({ source: 'configured', role, contract });
}

/**
 * Posture of a runner declared inline in `planner`/`implementer`: it runs in
 * the project directory, unstaged, so the disclosure the owner confirms must
 * say so.
 */
export function inlineRunnerSecurityPosture(
  role: CustomRunnerSecurityPosture['role'],
  contract: CustomCommandContract,
): CustomRunnerSecurityPosture {
  return canonicalPosture({ source: 'inline', role, contract });
}

/**
 * The posture is what the owner is asked to accept, so it must be the exact
 * canonical description of how this runner is executed — not merely a posture
 * whose result field happens to line up.
 */
export function postureDescribesRunner(
  posture: CustomRunnerSecurityPosture,
  runner: ConfiguredCustomRunner,
): boolean {
  return (
    canonicalJSON(posture) ===
    canonicalJSON(
      canonicalPosture({
        source: runner.source,
        role: posture.role,
        contract: runner.command.contract,
      }),
    )
  );
}

export function parseConfiguredCustomRunner(input: unknown): ConfiguredCustomRunner | null {
  const parsed = ConfiguredCustomRunnerSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseCustomRunnerSecurityPosture(
  input: unknown,
): CustomRunnerSecurityPosture | null {
  const parsed = CustomRunnerSecurityPostureSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseCustomRunnerAdmissionScope(input: unknown): CustomRunnerAdmissionScope | null {
  const parsed = CustomRunnerAdmissionScopeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

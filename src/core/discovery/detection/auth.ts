import { z } from 'zod';
import { assertNever } from '../../../utils/type-guards.js';
import { PROVIDER_ORACLE_TOOL_IDS } from '../../runners/cli-tool/catalog.js';
import type { CliToolId } from '../../runners/cli-tool/types.js';

/**
 * One per-provider authentication fact reported by a CLI's own credential
 * listing. Carries the provider id (when the listing prints one), its display
 * name, the source kind and, for environment entries, the env var name — never
 * a credential value.
 */
export const CliProviderAuthFactSchema = z
  .object({
    /** The listing's provider id, the model-id segment it backs; the boxed listing prints none. */
    id: z.string().min(1).max(200).optional(),
    provider: z.string().min(1).max(200),
    source: z.enum(['oauth', 'api', 'env', 'stored']),
    envVar: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CliProviderAuthFact = z.infer<typeof CliProviderAuthFactSchema>;

const CliProviderAuthFactsSchema = z.array(CliProviderAuthFactSchema).max(64).readonly();

export const CLI_PROVIDER_AUTH_UNREADABLE_REASONS = [
  'timeout',
  'exit-failure',
  'parse-failure',
  'version-mismatch',
  'not-probed',
] as const;
export type CliProviderAuthUnreadableReason = (typeof CLI_PROVIDER_AUTH_UNREADABLE_REASONS)[number];

/**
 * What a CLI's own credential listing said. `empty` is the truthful negative —
 * signed in to nothing — and is never the same fact as `unreadable`, which
 * names why the listing could not be read.
 */
export const CliProviderAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), facts: CliProviderAuthFactsSchema }).strict(),
  z.object({ kind: z.literal('empty') }).strict(),
  z
    .object({ kind: z.literal('unreadable'), reason: z.enum(CLI_PROVIDER_AUTH_UNREADABLE_REASONS) })
    .strict(),
]);
export type CliProviderAuth = z.infer<typeof CliProviderAuthSchema>;

const NO_PROVIDER_AUTH_FACTS: readonly CliProviderAuthFact[] = [];

/**
 * Reads a persisted `providerAuth` payload of any vintage: the union itself,
 * the legacy bare fact array, or nothing at all. An oracle tool with nothing
 * recorded was never probed; a tool without an oracle has no fact to record.
 */
export function normalizeProviderAuth(
  input: Readonly<{ tool: CliToolId; providerAuth: unknown }>,
): CliProviderAuth | undefined {
  const union = CliProviderAuthSchema.safeParse(input.providerAuth);
  if (union.success) return union.data;
  const legacy = CliProviderAuthFactsSchema.safeParse(input.providerAuth);
  if (legacy.success) {
    return legacy.data.length === 0 ? { kind: 'empty' } : { kind: 'read', facts: legacy.data };
  }
  return PROVIDER_ORACLE_TOOL_IDS.some((id) => id === input.tool)
    ? { kind: 'unreadable', reason: 'not-probed' }
    : undefined;
}

/**
 * The facts a reader may count, or `undefined` when the listing said nothing
 * countable. `empty` counts as zero facts; an unreadable listing counts nothing.
 */
export function cliProviderAuthFacts(
  providerAuth: CliProviderAuth | undefined,
): readonly CliProviderAuthFact[] | undefined {
  if (providerAuth === undefined) return undefined;
  switch (providerAuth.kind) {
    case 'read':
      return providerAuth.facts;
    case 'empty':
      return NO_PROVIDER_AUTH_FACTS;
    case 'unreadable':
      return undefined;
    default:
      return assertNever(providerAuth);
  }
}

import { z } from 'zod';
import { writeSecureFile } from '../../lib/fs.js';
import {
  TRUST_STORE_MAX_RECEIPTS,
  readTrustStore,
  resolveTrustStorePath,
  trustedProjectIdentity,
} from '../trust/receipt-store.js';
import { hashHooksConfig } from './trust-digest.js';

const HOOK_TRUST_FILE = 'hooks.json';
const HOOK_TRUST_VERSION = 1;

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const HookTrustReceiptSchema = z
  .strictObject({
    version: z.literal(HOOK_TRUST_VERSION),
    projectIdentity: DigestSchema,
    configDigest: DigestSchema,
    trustedAt: z.number().finite().nonnegative(),
  })
  .readonly();

const HookTrustFileSchema = z
  .strictObject({
    version: z.literal(HOOK_TRUST_VERSION),
    receipts: z.array(HookTrustReceiptSchema).max(TRUST_STORE_MAX_RECEIPTS),
  })
  .readonly();

type HookTrustFile = z.infer<typeof HookTrustFileSchema>;

function parseHookTrustFile(value: unknown): HookTrustFile | null {
  const parsed = HookTrustFileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A grant is a fact about this machine and this checkout, so it is looked up in
 * the owner's trust store — never in the project. A repository that ships its
 * own receipt therefore grants itself nothing.
 */
export function isHooksConfigTrusted(projectDir: string, hooks: unknown): boolean {
  const identity = trustedProjectIdentity(projectDir);
  if (identity === null) return false;
  const read = readTrustStore(resolveTrustStorePath(HOOK_TRUST_FILE), parseHookTrustFile);
  if (read.kind !== 'value') return false;
  const receipt = read.value.receipts.find((candidate) => candidate.projectIdentity === identity);
  if (receipt === undefined) return false;
  return receipt.configDigest === hashHooksConfig(projectDir, hooks);
}

/**
 * Persisting the grant is best-effort in one direction only: an unresolvable
 * checkout or a store this process could not verify leaves no receipt, so the
 * next run asks again. Overwriting a store that failed verification would
 * discard whatever made it fail.
 */
export function markHooksConfigTrusted(projectDir: string, hooks: unknown): void {
  const identity = trustedProjectIdentity(projectDir);
  if (identity === null) return;
  const path = resolveTrustStorePath(HOOK_TRUST_FILE);
  const read = readTrustStore(path, parseHookTrustFile);
  if (read.kind === 'invalid') return;
  const existing = read.kind === 'value' ? read.value.receipts : [];
  const receipt = HookTrustReceiptSchema.parse({
    version: HOOK_TRUST_VERSION,
    projectIdentity: identity,
    configDigest: hashHooksConfig(projectDir, hooks),
    trustedAt: Date.now(),
  });
  const receipts = [
    ...existing.filter((candidate) => candidate.projectIdentity !== identity),
    receipt,
  ].slice(-TRUST_STORE_MAX_RECEIPTS);
  writeSecureFile(path, `${JSON.stringify({ version: HOOK_TRUST_VERSION, receipts }, null, 2)}\n`);
}

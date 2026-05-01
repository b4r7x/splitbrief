import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeSecureFile } from '../../lib/fs.js';
import { canonicalJSON } from '../../utils/canonical-json.js';

const TRUST_FILE = 'hook-trust.json';
const TRUST_VERSION = 1;

const TrustFileSchema = z.object({
  version: z.number(),
  trusted_hash: z.string(),
});
type TrustFile = z.infer<typeof TrustFileSchema>;

export function hashHooksConfig(hooks: unknown): string {
  const json = canonicalJSON(hooks ?? null);
  const hex = createHash('sha256').update(json, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

function trustFilePath(projectDir: string): string {
  return join(projectDir, '.diptych', TRUST_FILE);
}

export function isHooksConfigTrusted(projectDir: string, hooks: unknown): boolean {
  const path = trustFilePath(projectDir);
  if (!existsSync(path)) return false;
  try {
    const result = TrustFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!result.success) return false;
    if (result.data.version !== TRUST_VERSION) return false;
    return result.data.trusted_hash === hashHooksConfig(hooks);
  } catch {
    return false;
  }
}

export function markHooksConfigTrusted(projectDir: string, hooks: unknown): void {
  const file: TrustFile = { version: TRUST_VERSION, trusted_hash: hashHooksConfig(hooks) };
  writeSecureFile(trustFilePath(projectDir), JSON.stringify(file, null, 2) + '\n');
}

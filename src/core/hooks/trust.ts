import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { writeSecureFile } from '../../lib/fs.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { HookEventSchema, HooksConfigSchema } from '../schemas/hooks.js';

const TRUST_FILE = 'hook-trust.json';
const TRUST_VERSION = 1;

const TrustFileSchema = z.object({
  version: z.number(),
  trusted_hash: z.string(),
});
type TrustFile = z.infer<typeof TrustFileSchema>;

type ModuleDigest = {
  path: string;
  sha256?: string;
  error?: string;
};

export function hashHooksConfig(hooks: unknown): string;
export function hashHooksConfig(projectDir: string, hooks: unknown): string;
export function hashHooksConfig(...args: [hooks: unknown] | [projectDir: string, hooks: unknown]): string {
  const projectDir = args.length === 2 ? args[0] : undefined;
  const hooks = args.length === 2 ? args[1] : args[0];
  const json = canonicalJSON({
    hooks: hooks ?? null,
    moduleDigests: projectDir ? collectModuleDigests(projectDir, hooks) : [],
  });
  const hex = createHash('sha256').update(json, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

function collectModuleDigests(projectDir: string, hooks: unknown): ModuleDigest[] {
  const parsed = HooksConfigSchema.safeParse(hooks);
  if (!parsed.success) return [];

  const digests: ModuleDigest[] = [];
  for (const event of HookEventSchema.options) {
    for (const entry of parsed.data[event] ?? []) {
      if (entry.kind !== 'module') continue;
      digests.push(hashHookModule(projectDir, entry.path));
    }
  }
  return digests.toSorted((a, b) => a.path.localeCompare(b.path));
}

function hashHookModule(projectDir: string, modulePath: string): ModuleDigest {
  try {
    assertExistingPathConfined(modulePath, projectDir);
    const content = readFileSync(resolve(projectDir, modulePath));
    return {
      path: modulePath,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  } catch (err) {
    return { path: modulePath, error: toErrorMessage(err) };
  }
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
    return result.data.trusted_hash === hashHooksConfig(projectDir, hooks);
  } catch {
    return false;
  }
}

export function markHooksConfigTrusted(projectDir: string, hooks: unknown): void {
  const file: TrustFile = { version: TRUST_VERSION, trusted_hash: hashHooksConfig(projectDir, hooks) };
  writeSecureFile(trustFilePath(projectDir), JSON.stringify(file, null, 2) + '\n');
}

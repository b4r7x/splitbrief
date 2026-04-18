import { z } from 'zod';
import type { DetectedModel } from '../../core/types/config-options.js';
import type { CliToolId } from '../../core/schemas/enums.js';
import { runCommand } from '../../lib/process/spawn.js';
import { fetchJsonWithTimeout } from './client.js';
import { buildPricingFields } from './metadata.js';
import { warnError } from '../../lib/warn.js';
import { DISCOVERY_SUBPROCESS_TIMEOUT_MS, DISCOVERY_HTTP_TIMEOUT_MS } from '../constants.js';

const KILO_MODELS_URL = 'https://api.kilo.ai/api/gateway/models';

const KiloModelSchema = z.object({
  id: z.string(),
  context_length: z.number().optional(),
  pricing: z
    .object({
      prompt: z.number().optional(),
      completion: z.number().optional(),
    })
    .optional(),
});

const KiloModelsResponseSchema = z.object({
  data: z.array(KiloModelSchema),
});

function parseSubprocessLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('-') && !line.startsWith('='))
    .filter((line) => !/^error(?::|\s)/i.test(line));
}

async function discoverSubprocessModels(command: string, args: string[]): Promise<DetectedModel[]> {
  try {
    const { stdout } = await runCommand(command, args, {
      timeout: DISCOVERY_SUBPROCESS_TIMEOUT_MS,
    });
    return parseSubprocessLines(stdout).map((id) => ({ id }));
  } catch (err) {
    if (!isMissingBinary(err)) warnError(`discoverSubprocessModels(${command})`, err);
    return [];
  }
}

function isMissingBinary(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'ENOENT';
}

async function discoverKilo(): Promise<DetectedModel[]> {
  try {
    const json = await fetchJsonWithTimeout(KILO_MODELS_URL, DISCOVERY_HTTP_TIMEOUT_MS);
    const parsed = KiloModelsResponseSchema.safeParse(json);
    if (!parsed.success) return [];

    return parsed.data.data.map((m) => {
      const model: DetectedModel = { id: m.id };
      if (m.context_length !== undefined) model.contextLength = m.context_length;
      return { ...model, ...buildPricingFields(m.pricing?.prompt, m.pricing?.completion) };
    });
  } catch (err) {
    warnError('discoverKilo', err);
    return [];
  }
}

export async function discoverAllCliTools(): Promise<Partial<Record<CliToolId, DetectedModel[]>>> {
  const [aider, opencode, kilo] = await Promise.all([
    discoverSubprocessModels('aider', ['--list-models', '']),
    discoverSubprocessModels('opencode', ['models']),
    discoverKilo(),
  ]);

  const result: Partial<Record<CliToolId, DetectedModel[]>> = {};
  if (aider.length > 0) result.aider = aider;
  if (opencode.length > 0) result.opencode = opencode;
  if (kilo.length > 0) result['kilo-code'] = kilo;
  return result;
}

import { z } from 'zod';
import { catalogLines, isCatalogHeading } from './listing.js';
import {
  type NativeCliModelCatalogEntry,
  EMBEDDING_FAMILY,
  EMBEDDING_CAPABILITIES,
  type NativeCliModelCatalog,
  catalogFromEntries,
} from './entries.js';

const PROVIDER_QUALIFIED_SELECTION_ID_PATTERN = /^[^\s/][^\s]*(?:\/[^\s/][^\s]*)+$/;

// `opencode models --verbose` (1.x) and `kilo models --verbose` print a
// provider-qualified id, then the model's JSON object closed by a `}` at
// column 0. Verified against opencode 1.18.15 and kilo 7.0.49.
const VerboseModelBlockSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    family: z.string().optional(),
    limit: z
      .object({ context: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
    variants: z.record(z.string(), z.unknown()).optional(),
    capabilities: z
      .object({
        toolcall: z.boolean().optional(),
        input: z.record(z.string(), z.boolean()).optional(),
        output: z.record(z.string(), z.boolean()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const OpenCodeApiModelSchema = z
  .object({
    id: z.string().trim().min(1),
    providerID: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    family: z.string().optional(),
    variants: z.array(z.object({ id: z.string().trim().min(1) }).passthrough()).optional(),
    capabilities: z
      .object({
        tools: z.boolean().optional(),
        input: z.array(z.string().trim().min(1)).optional(),
        output: z.array(z.string().trim().min(1)).optional(),
      })
      .passthrough()
      .optional(),
    limit: z
      .object({ context: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const OpenCodeApiCatalogSchema = z.object({ data: z.array(OpenCodeApiModelSchema) }).passthrough();

function isProviderQualifiedSelectionId(value: string): boolean {
  return PROVIDER_QUALIFIED_SELECTION_ID_PATTERN.test(value);
}

function verboseBlockFields(
  json: string,
): Omit<NativeCliModelCatalogEntry, 'nativeOrder' | 'selectionId'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const block = VerboseModelBlockSchema.safeParse(parsed);
  if (!block.success) return null;

  // `kilo models --verbose` published `"limit": { "context": 0 }` for four image
  // models on 2026-09-05 (kilo 7.0.49): no text window, not a zero-token one.
  const context = block.data.limit?.context;
  const variants = block.data.variants;
  const toolcall = block.data.capabilities?.toolcall;
  // kilo 7.0.49 declares every input and output as a flag: text, audio, image, video, pdf.
  // SPLITBRIEF sends text and images, so the image flag is the input fact it reads.
  const input = block.data.capabilities?.input;
  const output = block.data.capabilities?.output;
  return {
    ...(block.data.name === undefined ? {} : { displayName: block.data.name }),
    ...(context === undefined || context === 0 ? {} : { contextWindow: context }),
    ...(variants === undefined ? {} : { nativeReasoningEfforts: Object.keys(variants) }),
    ...(toolcall === undefined ? {} : { supportsToolCalls: toolcall }),
    ...(input === undefined
      ? {}
      : { inputModalities: input.image === true ? ['text', 'image'] : ['text'] }),
    ...(output === undefined
      ? {}
      : {
          outputModalities: Object.entries(output).flatMap(([modality, declared]) =>
            declared ? [modality] : [],
          ),
        }),
    ...(block.data.family === EMBEDDING_FAMILY ? { capabilities: EMBEDDING_CAPABILITIES } : {}),
  };
}

function parseProviderQualifiedLines(
  input: Readonly<{
    tool: 'opencode' | 'kilo-code';
    stdout: string;
  }>,
): NativeCliModelCatalog | null {
  const lines = catalogLines(input.stdout);
  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  let index = 0;
  while (index < lines.length) {
    const selectionId = lines[index]?.trim() ?? '';
    index += 1;
    if (isCatalogHeading(selectionId)) continue;
    if (!isProviderQualifiedSelectionId(selectionId)) return null;
    if (lines[index] !== '{') {
      entries.push({ selectionId });
      continue;
    }
    const close = lines.indexOf('}', index + 1);
    if (close === -1) return null;
    const fields = verboseBlockFields(lines.slice(index, close + 1).join('\n'));
    if (fields === null) return null;
    entries.push({ selectionId, ...fields });
    index = close + 1;
  }
  return entries.length === 0 ? null : catalogFromEntries({ tool: input.tool, entries });
}

// `opencode api GET /api/model --standalone` starts a server of its own and asks
// it for every model it serves. On opencode 2.0.29 and 2.0.32 it lists the
// models of every provider the child's environment and sign-in reach.
//
// `id` is the selectable name and `modelID` the upstream model it routes to, so
// an alias repeats a sibling's `modelID` (`gpt-5.6-luna-fast` routes to
// `gpt-5.6-luna`). Keying on `modelID` collapsed 118 rows to 105. `providerID/id`
// reproduces `opencode models` exactly. Verified against opencode 2.0.14.
export function parseOpenCodeNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = OpenCodeApiCatalogSchema.safeParse(json);
  if (!parsed.success) return null;

  const entries = parsed.data.data.map((model) => {
    const context = model.limit?.context;
    const toolcall = model.capabilities?.tools;
    const input = model.capabilities?.input;
    const output = model.capabilities?.output;
    return {
      selectionId: `${model.providerID}/${model.id}`,
      ...(model.name === undefined ? {} : { displayName: model.name }),
      ...(context === undefined || context === 0 ? {} : { contextWindow: context }),
      ...(model.variants === undefined
        ? {}
        : { nativeReasoningEfforts: model.variants.map((variant) => variant.id) }),
      ...(toolcall === undefined ? {} : { supportsToolCalls: toolcall }),
      ...(input === undefined ? {} : { inputModalities: input }),
      ...(output === undefined ? {} : { outputModalities: output }),
      ...(model.family === EMBEDDING_FAMILY ? { capabilities: EMBEDDING_CAPABILITIES } : {}),
    };
  });
  return catalogFromEntries({ tool: 'opencode', entries });
}

// opencode 1.x listed models itself; `api` arrived with the 2.x server. A 1.x
// install is still a fully admitted seat (`minimumAdmittedVersion` 0.5.0), and
// npm's `opencode-ai` tops out at 1.18.32, so this is a live path, not history.
export function parseOpenCodeVerboseModelCatalog(stdout: string): NativeCliModelCatalog | null {
  return parseProviderQualifiedLines({ tool: 'opencode', stdout });
}

export function parseKiloNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  return parseProviderQualifiedLines({ tool: 'kilo-code', stdout });
}

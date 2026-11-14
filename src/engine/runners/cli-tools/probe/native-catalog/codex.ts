import { z } from 'zod';
import {
  type NativeCliModelCatalog,
  type NativeCliModelCatalogEntry,
  catalogFromEntries,
  distinct,
  equalStringLists,
} from './entries.js';

const CodexReasoningEffortSchema: z.ZodType<string> = z
  .union([
    z.string().trim().min(1),
    z.object({ effort: z.string().trim().min(1) }),
    z.object({ reasoning_effort: z.string().trim().min(1) }),
  ])
  .transform((value): string => {
    if (typeof value === 'string') return value;
    return 'effort' in value ? value.effort : value.reasoning_effort;
  });

const CodexNativeModelSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    display_name: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    is_default: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    hidden: z.boolean().optional(),
    is_hidden: z.boolean().optional(),
    visibility: z.string().trim().min(1).optional(),
    context_window: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
    reasoning_efforts: z.array(CodexReasoningEffortSchema).optional(),
    supported_reasoning_efforts: z.array(CodexReasoningEffortSchema).optional(),
    supported_reasoning_levels: z.array(CodexReasoningEffortSchema).optional(),
    default_reasoning_level: z.string().trim().min(1).optional(),
    input_modalities: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const CodexNativeCatalogSchema = z
  .object({
    models: z.array(CodexNativeModelSchema),
  })
  .passthrough();

type CodexNativeModel = z.infer<typeof CodexNativeModelSchema>;

function codexNativeEntry(
  input: Readonly<{ model: CodexNativeModel }>,
): Omit<NativeCliModelCatalogEntry, 'nativeOrder'> | null {
  const selectionId = distinct([input.model.id, input.model.slug, input.model.model]);
  const displayName = distinct([
    input.model.display_name,
    input.model.displayName,
    input.model.name,
  ]);
  const nativeDefault = distinct([input.model.is_default, input.model.isDefault]);
  // `codex debug models` spells `hidden` as `visibility`: its picker shows only `list`.
  const nativeHidden = distinct([
    input.model.hidden,
    input.model.is_hidden,
    input.model.visibility === undefined ? undefined : input.model.visibility !== 'list',
  ]);
  const contextWindow = distinct([input.model.context_window, input.model.contextWindow]);
  const nativeDefaultReasoningEffort = input.model.default_reasoning_level;
  const inputModalities = input.model.input_modalities;
  const nativeReasoningEfforts = distinct(
    [
      input.model.reasoning_efforts,
      input.model.supported_reasoning_efforts,
      input.model.supported_reasoning_levels,
    ],
    equalStringLists,
  );
  if (
    selectionId === undefined ||
    selectionId === null ||
    displayName === null ||
    nativeDefault === null ||
    nativeHidden === null ||
    contextWindow === null ||
    nativeReasoningEfforts === null
  ) {
    return null;
  }

  return {
    selectionId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(nativeDefault === undefined ? {} : { nativeDefault }),
    ...(nativeHidden === undefined ? {} : { nativeHidden }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(nativeDefaultReasoningEffort === undefined ? {} : { nativeDefaultReasoningEffort }),
    ...(nativeReasoningEfforts === undefined
      ? {}
      : { nativeReasoningEfforts: [...nativeReasoningEfforts] }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
  };
}

export function parseCodexNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = CodexNativeCatalogSchema.safeParse(json);
  if (!parsed.success) return null;

  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const model of parsed.data.models) {
    const entry = codexNativeEntry({ model });
    if (entry === null) return null;
    entries.push(entry);
  }
  return catalogFromEntries({ tool: 'codex', entries });
}

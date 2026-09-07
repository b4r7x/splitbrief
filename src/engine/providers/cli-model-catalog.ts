import { z } from 'zod';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { stripTerminalControls } from '../../utils/display-text.js';

export type NativeCliCatalogTool =
  | 'codex'
  | 'opencode'
  | 'kilo-code'
  | 'cursor'
  | 'command-code'
  | 'copilot';

export interface NativeCliModelCatalogEntry {
  readonly selectionId: string;
  readonly nativeOrder: number;
  readonly displayName?: string | undefined;
  readonly nativeDefault?: boolean | undefined;
  readonly nativeHidden?: boolean | undefined;
  readonly nativeReasoningEfforts?: readonly string[] | undefined;
  readonly contextWindow?: number | undefined;
}

export interface NativeCliModelCatalog {
  readonly tool: NativeCliCatalogTool;
  readonly models: readonly NativeCliModelCatalogEntry[];
}

const PROVIDER_QUALIFIED_SELECTION_ID_PATTERN = /^[^\s/][^\s]*(?:\/[^\s/][^\s]*)+$/;
const CATALOG_HEADING_PATTERN = /^(?:available\s+)?models?\s*:?$/i;
const CURSOR_MODEL_LINE = /^(\S+) - (.+)$/;
// `cmd --list-models` aligns a bare selection id against a capability blurb with
// a run of spaces, and only first-party ids drop the `provider/` prefix. The id
// shape rejects the provider headings, the `cmd --model …` usage examples and
// the trailing `Docs:` line, none of which are selectable.
const COMMAND_CODE_MODEL_LINE = /^([a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*)*) {2,}(.+)$/i;
// `copilot help config` prints the `--model` enum as quoted bullets under its
// `model` key, and a blank line separates the last bullet from the next config
// key, so the first non-bullet line ends the enum rather than interrupting it.
const COPILOT_MODEL_KEY_LINE = /^`model`:/;
const COPILOT_MODEL_BULLET = /^-\s+"([^"]+)"$/;
const NATIVE_DEFAULT_SUFFIX = /\s*\(default\)$/i;

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
    context_window: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
    reasoning_efforts: z.array(CodexReasoningEffortSchema).optional(),
    supported_reasoning_efforts: z.array(CodexReasoningEffortSchema).optional(),
  })
  .passthrough();

const CodexNativeCatalogSchema = z
  .object({
    models: z.array(CodexNativeModelSchema),
  })
  .passthrough();

type CodexNativeModel = z.infer<typeof CodexNativeModelSchema>;

// `opencode models --verbose` and `kilo models --verbose` print a
// provider-qualified id, then the model's JSON object closed by a `}` at
// column 0. Verified against opencode 1.18.15 and kilo 7.0.49.
const VerboseModelBlockSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    limit: z
      .object({ context: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
    variants: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

function distinct<T>(
  values: readonly (T | undefined)[],
  equals: (a: T, b: T) => boolean = (a, b) => a === b,
): T | null | undefined {
  let selected: T | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (selected !== undefined && !equals(selected, value)) return null;
    selected = value;
  }
  return selected;
}

function equalStringLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function catalogFromEntries(
  input: Readonly<{
    tool: NativeCliCatalogTool;
    entries: readonly Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[];
  }>,
): NativeCliModelCatalog {
  return {
    tool: input.tool,
    models: input.entries.map((entry, nativeOrder) => ({ ...entry, nativeOrder })),
  };
}

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
  const nativeHidden = distinct([input.model.hidden, input.model.is_hidden]);
  const contextWindow = distinct([input.model.context_window, input.model.contextWindow]);
  const nativeReasoningEfforts = distinct(
    [input.model.reasoning_efforts, input.model.supported_reasoning_efforts],
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
    ...(nativeReasoningEfforts === undefined
      ? {}
      : { nativeReasoningEfforts: [...nativeReasoningEfforts] }),
  };
}

function isProviderQualifiedSelectionId(value: string): boolean {
  return PROVIDER_QUALIFIED_SELECTION_ID_PATTERN.test(value);
}

function catalogLines(stdout: string): readonly string[] {
  return stripTerminalControls(stdout, { preserveLineBreaks: true }).split('\n');
}

function cleanCatalogLines(stdout: string): readonly string[] {
  return catalogLines(stdout).map((line) => line.trim());
}

function isCatalogHeading(value: string): boolean {
  return value.length === 0 || CATALOG_HEADING_PATTERN.test(value) || /^=+$/.test(value);
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
  return {
    ...(block.data.name === undefined ? {} : { displayName: block.data.name }),
    ...(context === undefined || context === 0 ? {} : { contextWindow: context }),
    ...(variants === undefined ? {} : { nativeReasoningEfforts: Object.keys(variants) }),
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
  return catalogFromEntries({ tool: input.tool, entries });
}

function parseDashSeparatedLines(
  input: Readonly<{
    tool: 'cursor';
    stdout: string;
    pattern: RegExp;
  }>,
): NativeCliModelCatalog | null {
  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of cleanCatalogLines(input.stdout)) {
    if (isCatalogHeading(line)) continue;
    const match = input.pattern.exec(line);
    if (match === null) continue;
    const selectionId = match[1];
    const listedName = match[2];
    if (selectionId === undefined || listedName === undefined) continue;
    const nativeDefault = NATIVE_DEFAULT_SUFFIX.test(listedName);
    const stripped = listedName.replace(NATIVE_DEFAULT_SUFFIX, '').trimEnd();
    entries.push({
      selectionId,
      displayName: nativeDefault && stripped.length > 0 ? stripped : listedName,
      ...(nativeDefault ? { nativeDefault: true } : {}),
    });
  }
  return entries.length === 0 ? null : catalogFromEntries({ tool: input.tool, entries });
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

export function parseOpenCodeNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  return parseProviderQualifiedLines({ tool: 'opencode', stdout });
}

export function parseKiloNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  return parseProviderQualifiedLines({ tool: 'kilo-code', stdout });
}

export function parseCursorNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  return parseDashSeparatedLines({ tool: 'cursor', stdout, pattern: CURSOR_MODEL_LINE });
}

export function parseCommandCodeNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of cleanCatalogLines(stdout)) {
    if (isCatalogHeading(line)) continue;
    const match = COMMAND_CODE_MODEL_LINE.exec(line);
    const selectionId = match?.[1];
    const blurb = match?.[2];
    if (selectionId === undefined || blurb === undefined) continue;
    // The second column is a capability blurb, not a display name, so the row
    // contributes no displayName and the picker falls back to the id.
    entries.push({
      selectionId,
      ...(NATIVE_DEFAULT_SUFFIX.test(blurb) ? { nativeDefault: true } : {}),
    });
  }
  return entries.length === 0 ? null : catalogFromEntries({ tool: 'command-code', entries });
}

export function parseCopilotHelpConfigCatalog(stdout: string): NativeCliModelCatalog | null {
  const lines = cleanCatalogLines(stdout);
  const start = lines.findIndex((line) => COPILOT_MODEL_KEY_LINE.test(line));
  if (start === -1) return null;

  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of lines.slice(start + 1)) {
    const selectionId = COPILOT_MODEL_BULLET.exec(line)?.[1];
    if (selectionId === undefined) break;
    entries.push({ selectionId });
  }
  return entries.length === 0 ? null : catalogFromEntries({ tool: 'copilot', entries });
}

export function nativeCliCatalogToDetectedModels(catalog: NativeCliModelCatalog): DetectedModel[] {
  return catalog.models.map((model) => ({
    id: model.selectionId,
    nativeOrder: model.nativeOrder,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(model.nativeDefault === undefined ? {} : { nativeDefault: model.nativeDefault }),
    ...(model.nativeHidden === undefined ? {} : { nativeHidden: model.nativeHidden }),
    ...(model.contextWindow === undefined ? {} : { contextLength: model.contextWindow }),
    ...(model.nativeReasoningEfforts === undefined
      ? {}
      : {
          nativeReasoningEfforts: [...model.nativeReasoningEfforts],
          supportsReasoning: model.nativeReasoningEfforts.length > 0,
        }),
  }));
}

export function parseCursorModels(stdout: string): DetectedModel[] | null {
  const catalog = parseCursorNativeModelCatalog(stdout);
  return catalog === null ? null : nativeCliCatalogToDetectedModels(catalog);
}

import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { isCliToolId } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { ResolvedModelMembership } from '../../../engine/providers/model/types.js';
import type { RightRow } from '../model-catalog/types.js';

export interface ListingSource {
  readonly source: string;
  /** The noun the tool's own list uses for one row. */
  readonly rowNoun: string;
  /** The same noun for more than one row; `alias` does not take a bare `s`. */
  readonly rowNounPlural: string;
  readonly unverifiedForPlan: boolean;
}

/**
 * Where each tool's rows really come from, in the tool's own words. Checked against
 * `declaredCatalogProbe` (`engine/runners/cli-tools/probe/catalog.ts`) and the tools themselves on
 * 2026-09-09: claude-code 2.1.265 prints no alias table, copilot 1.0.77 prints its 25-id enum,
 * cursor-agent 2026.09.08-6caf4ff prints 223 model rows.
 */
const LISTING_SOURCES: Readonly<Record<CliToolId, ListingSource>> = {
  'claude-code': {
    source: "from Claude's documented aliases",
    rowNoun: 'alias',
    rowNounPlural: 'aliases',
    unverifiedForPlan: false,
  },
  copilot: {
    source: 'from copilot help config',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: true,
  },
  cursor: {
    source: 'from cursor-agent --list-models',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  opencode: {
    source: 'from opencode api GET /api/model --standalone',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  'kilo-code': {
    source: 'from kilo models --verbose',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  codex: {
    source: 'from codex debug models',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  'command-code': {
    source: 'from cmd --list-models',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  antigravity: {
    source: 'from agy models',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
};

/** A provider that is not a CLI tool lists through the shared catalog, which knows no account. */
const CATALOG_LISTING_SOURCE: ListingSource = {
  source: 'from models.dev',
  rowNoun: 'model',
  rowNounPlural: 'models',
  unverifiedForPlan: true,
};

export function pickerListingSource(toolId: string | undefined): ListingSource {
  if (toolId !== undefined && isCliToolId(toolId)) return LISTING_SOURCES[toolId];
  return CATALOG_LISTING_SOURCE;
}

const CUSTOM_MODEL_EXAMPLE_COUNT = 3;
/** Rows the tool itself listed or ships as its floor; models.dev suggestions and custom rows are not its spelling. */
const TOOL_OWN_MEMBERSHIPS: ReadonlySet<ResolvedModelMembership> = new Set([
  'confirmed',
  'stale',
  'bundled-suggestion',
]);

/**
 * The custom-model entry's examples come from the highlighted tool's own listing, spelled as that
 * tool takes them: Claude Code `claude-opus-5-5`, Codex a slug, OpenCode and Kilo `provider/model`.
 * An alias row gives the id it resolves to, because the alias is already a row. The examples teach
 * the id's form, so each names a different provider. A tool whose listing has not landed names the
 * command that lists its ids instead.
 */
export function customModelEntryCopy(
  input: Readonly<{ rows: readonly RightRow[]; toolId: string }>,
): Readonly<{ placeholder: string; examples: string[] }> {
  const ids: string[] = [];
  const providers = new Set<string>();
  for (const row of input.rows) {
    if (ids.length === CUSTOM_MODEL_EXAMPLE_COUNT) break;
    if (row.kind !== 'model' || isAutomaticModel(row.model.id)) continue;
    const { membership } = row.model;
    if (membership === undefined || !TOOL_OWN_MEMBERSHIPS.has(membership)) continue;
    const id = row.model.catalogModelId ?? row.model.id;
    const provider = id.includes('/') ? id.slice(0, id.indexOf('/')) : id;
    if (providers.has(provider)) continue;
    providers.add(provider);
    ids.push(id);
  }
  const [first, ...rest] = ids;
  return first === undefined
    ? { placeholder: `an id ${pickerListingSource(input.toolId).source}`, examples: [] }
    : { placeholder: `e.g. ${first}`, examples: rest };
}

import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { isCliToolId } from '../../../core/runners/cli-tool/catalog.js';
import { declaredCatalogProbe } from '../../../engine/runners/cli-tools/probe/catalog.js';
import type { ResolvedModelMembership } from '../../../engine/providers/model/types.js';
import type { RightRow } from '../model-catalog/types.js';

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
  if (first !== undefined) return { placeholder: `e.g. ${first}`, examples: rest };
  const probe = isCliToolId(input.toolId) ? declaredCatalogProbe(input.toolId) : undefined;
  const placeholder =
    probe?.kind === 'catalog' ? `an id from ${probe.command.join(' ')}` : 'Model id';
  return { placeholder, examples: [] };
}

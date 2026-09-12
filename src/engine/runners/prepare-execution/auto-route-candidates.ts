import {
  blendedPricePer1M,
  type AutoRouteCandidateRow,
} from '../../../core/config/accessors/implementer-profiles.js';
import type { CliToolDetection, DetectedModel } from '../../../core/discovery/detection.js';
import { isAutoCheapestModel } from '../../../core/providers/automatic-model.js';
import {
  IMPLEMENTER_CLI_TOOL_IDS,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../../core/schemas/config.js';
import { ImplementerConfigSchema } from '../../../core/schemas/implementer-config.js';
import { includes } from '../../../utils/type-guards.js';
import { loadFreshRememberedSnapshot, type RememberedCliCatalog } from '../../detection/cache.js';

type PricedRow = Readonly<{
  row: AutoRouteCandidateRow;
  model: string;
  blended: number;
  contextLength: number;
}>;

function blendedPrice(model: DetectedModel): number | undefined {
  const { pricingInput, pricingOutput } = model;
  if (pricingInput === undefined || pricingOutput === undefined) return undefined;
  return blendedPricePer1M(pricingInput, pricingOutput);
}

/**
 * A derived row keeps the configured seat's own fields — arguments, effort,
 * watchdog — when it names that same tool, and carries nothing but the identity
 * otherwise. The model and the window always come from the catalog row.
 */
function seatBase(implementer: Config['implementer'], tool: CliToolId) {
  if (implementer.kind !== 'cli' || implementer.tool !== tool) {
    return { kind: 'cli', tool };
  }
  const { model: _model, contextLength: _contextLength, ...seat } = implementer;
  return seat;
}

function pricedRow(
  input: Readonly<{ config: Config; tool: CliToolId; model: DetectedModel }>,
): PricedRow | null {
  const { id, contextLength, pricingInput, pricingOutput } = input.model;
  // A row the tool hides from its own listing is not one a user could pick, so
  // routing must not pick it either.
  if (input.model.nativeHidden === true) return null;
  const blended = blendedPrice(input.model);
  if (blended === undefined) return null;
  const parsed = ImplementerConfigSchema.safeParse({
    ...seatBase(input.config.implementer, input.tool),
    model: id,
    ...(contextLength === undefined ? {} : { contextLength }),
  });
  if (!parsed.success) return null;
  return {
    row: { config: parsed.data, pricingInput, pricingOutput },
    model: id,
    blended,
    contextLength: contextLength ?? 0,
  };
}

function byBlendedPrice(left: PricedRow, right: PricedRow): number {
  return left.blended - right.blended || left.model.localeCompare(right.model);
}

/**
 * Every candidate becomes a prepared runner slot with its own admission probe
 * and start gate, so a tool contributes two rows at most: its cheapest priced
 * row — a price floor for a small brief — and its widest-window priced row,
 * which still holds a large one.
 */
function toolCandidates(
  input: Readonly<{ config: Config; catalog: RememberedCliCatalog }>,
): readonly PricedRow[] {
  const ranked = input.catalog.models
    .flatMap((model) => {
      const row = pricedRow({ config: input.config, tool: input.catalog.tool, model });
      return row === null ? [] : [row];
    })
    .sort(byBlendedPrice);
  const [cheapest] = ranked;
  if (cheapest === undefined) return [];
  const widest = ranked.reduce(
    (best, row) => (row.contextLength > best.contextLength ? row : best),
    cheapest,
  );
  return widest === cheapest ? [cheapest] : [cheapest, widest];
}

/**
 * The priced rows an `auto:cheapest` implementer seat can be routed to: only
 * tools the last readiness pass found ready, only rows the implementer config
 * schema accepts (a tool whose model policy forbids naming a model has none),
 * and only rows the catalog priced on both sides.
 */
export function buildAutoRouteCandidates(
  input: Readonly<{
    config: Config;
    cliTools: readonly CliToolDetection[];
    cliCatalogs?: readonly RememberedCliCatalog[] | undefined;
  }>,
): readonly AutoRouteCandidateRow[] {
  if (!isAutoCheapestModel(input.config.implementer.model)) return [];
  const ready = new Set<CliToolId>(
    input.cliTools
      .filter((cli) => cli.diagnostic.state === 'ready')
      .map((cli) => cli.tool)
      .filter((tool) => includes(IMPLEMENTER_CLI_TOOL_IDS, tool)),
  );

  const selected: PricedRow[] = [];
  for (const catalog of input.cliCatalogs ?? []) {
    if (!ready.has(catalog.tool)) continue;
    selected.push(...toolCandidates({ config: input.config, catalog }));
  }

  return selected.sort(byBlendedPrice).map((candidate) => candidate.row);
}

export async function loadAutoRouteCandidates(
  input: Readonly<{ projectDir: string; config: Config }>,
): Promise<readonly AutoRouteCandidateRow[]> {
  if (!isAutoCheapestModel(input.config.implementer.model)) return [];
  // A preparation holds no discovery context of its own, and every row it
  // yields becomes a runner slot that is probed, trusted and gated again — but
  // only against a record recent enough to describe this machine.
  const remembered = await loadFreshRememberedSnapshot(input.projectDir);
  if (remembered === null) return [];
  return buildAutoRouteCandidates({
    config: input.config,
    cliTools: remembered.cliTools,
    ...(remembered.cliCatalogs !== undefined && { cliCatalogs: remembered.cliCatalogs }),
  });
}

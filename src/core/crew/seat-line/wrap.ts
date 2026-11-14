import { truncateTerminalDisplayText, ELLIPSIS } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { CLI_TOOL_IDS } from '../../runners/cli-tool/catalog.js';
import {
  HANGING_SEPARATOR,
  CREW_IDENTITY_SEPARATOR,
  routesByProvider,
  toolWord,
} from '../identity.js';

/**
 * Every segment is an atom: `· h…` names no effort and `· claude-sonnet…` names a model that does
 * not exist. A budget that cannot seat a whole segment
 * sheds it, tail first, down to the leading one — the same print-whole-or-drop rule the picker's
 * catalog id follows. Only the leading segment is ever cut, and when the cut ends in the ellipsis
 * the trailing separator run goes with it.
 */
export function cutSeatIdentity(identity: string, budget: number): string {
  const truncated = truncateTerminalDisplayText(shedSegments(identity, budget), budget);
  if (!truncated.endsWith(ELLIPSIS)) return truncated;
  return `${truncated.slice(0, -ELLIPSIS.length).replace(HANGING_SEPARATOR, '')}${ELLIPSIS}`;
}

export function wrapSeatIdentity(identity: string, budget: number): string[] {
  if (getTerminalCellWidth(identity) <= budget) return [identity];
  const segments = identity.split(CREW_IDENTITY_SEPARATOR);
  const providerIndex = routeProviderIndex(segments);
  if (
    providerIndex !== undefined &&
    getTerminalCellWidth(segments.slice(providerIndex - 1).join(CREW_IDENTITY_SEPARATOR)) > budget
  ) {
    const fits = (row: readonly string[]): boolean =>
      getTerminalCellWidth(row.join(CREW_IDENTITY_SEPARATOR)) <= budget;
    const modelAndProvider = segments.slice(providerIndex - 1, providerIndex + 1);
    const toolAndModel = segments.slice(0, providerIndex);
    const providerAndAxes = segments.slice(providerIndex);
    return (
      fits(modelAndProvider)
        ? [
            [...segments.slice(0, providerIndex - 1), ...segments.slice(providerIndex + 1)],
            modelAndProvider,
          ]
        : fits(toolAndModel)
          ? [toolAndModel, providerAndAxes]
          : [toolAndModel.slice(0, -1), toolAndModel.slice(-1), providerAndAxes]
    ).map((row) => cutSeatIdentity(row.join(CREW_IDENTITY_SEPARATOR), budget));
  }
  return [
    segments.slice(0, 1).join(CREW_IDENTITY_SEPARATOR),
    segments.slice(1).join(CREW_IDENTITY_SEPARATOR),
  ].map((row) => cutSeatIdentity(row, budget));
}

const ROUTED_TOOL_WORDS: readonly string[] = CLI_TOOL_IDS.filter(routesByProvider).map((tool) =>
  toolWord({ tool }, 'cli'),
);

function routeProviderIndex(segments: readonly string[]): number | undefined {
  const toolIndex = segments.findIndex((segment) => ROUTED_TOOL_WORDS.includes(segment));
  const providerIndex = toolIndex + 2;
  return toolIndex >= 0 && segments[providerIndex]?.startsWith('via ') ? providerIndex : undefined;
}

function shedSegments(identity: string, budget: number): string {
  const segments = identity.split(CREW_IDENTITY_SEPARATOR);
  const width = (count: number): number =>
    getTerminalCellWidth(segments.slice(0, count).join(CREW_IDENTITY_SEPARATOR));
  const providerIndex = routeProviderIndex(segments);
  const keepModel = providerIndex !== undefined && width(providerIndex + 1) > budget;
  if (keepModel) segments.splice(providerIndex - 2, 1);
  const minimum = keepModel ? providerIndex - 1 : 1;
  let kept = segments.length;
  while (kept > minimum && width(kept) > budget) kept -= 1;
  return segments.slice(0, kept).join(CREW_IDENTITY_SEPARATOR);
}

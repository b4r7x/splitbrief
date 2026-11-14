import { Box } from 'ink';
import { type CommandCompletionRow, CommandCompletionMenu } from './command/menu.js';
import { computeCompletionCap, computeCompletionOverlayRows } from './layout.js';
import { ReferenceCompletionMenu } from './reference/menu.js';

const MAX_REFERENCE_SUGGESTIONS = 8;

interface CompletionOverlayProps {
  command: {
    filtered: CommandCompletionRow[];
    selectedIndex: number;
    fuzzyMatch: CommandCompletionRow | null;
  };
  reference: { filtered: string[]; selectedIndex: number };
  showCommand: boolean;
  showReference: boolean;
  /** The terminal height and the rows the box shows, which the lists open above. */
  rows: number;
  visibleRows: number;
}

/** The command or `@` list, drawn over the rows above the box. */
export function CompletionOverlay({
  command,
  reference,
  showCommand,
  showReference,
  rows,
  visibleRows,
}: CompletionOverlayProps) {
  const completionCap = computeCompletionCap(rows, visibleRows);
  const referenceSuggestionsCap = Math.min(MAX_REFERENCE_SUGGESTIONS, completionCap);
  const commandOverlayRows = showCommand
    ? computeCompletionOverlayRows({
        itemCount: command.filtered.length,
        maxVisible: completionCap,
        hasFuzzyMatch: command.fuzzyMatch !== null,
        hasEmptyMessage: command.filtered.length === 0 && command.fuzzyMatch === null,
      })
    : 0;
  const referenceOverlayRows = showReference
    ? computeCompletionOverlayRows({
        itemCount: reference.filtered.length,
        maxVisible: referenceSuggestionsCap,
      })
    : 0;
  return (
    <>
      {showCommand && (
        <Box position="absolute" width="100%" marginTop={-commandOverlayRows}>
          <CommandCompletionMenu
            filtered={command.filtered}
            selectedIndex={command.selectedIndex}
            fuzzyMatch={command.fuzzyMatch}
            maxVisible={completionCap}
          />
        </Box>
      )}
      {showReference && (
        <Box position="absolute" width="100%" marginTop={-referenceOverlayRows}>
          <ReferenceCompletionMenu
            filtered={reference.filtered}
            selectedIndex={reference.selectedIndex}
            maxVisible={referenceSuggestionsCap}
          />
        </Box>
      )}
    </>
  );
}

import { type CommandCompletionRow, CommandCompletionMenu } from './command/menu.js';
import { computeCompletionCap } from './layout.js';
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
  width: number;
  visibleRows: number;
}

/** The command or `@` list, drawn over the rows above the box. */
export function CompletionOverlay({
  command,
  reference,
  showCommand,
  showReference,
  rows,
  width,
  visibleRows,
}: CompletionOverlayProps) {
  const completionCap = computeCompletionCap(rows, visibleRows);
  const referenceSuggestionsCap = Math.min(MAX_REFERENCE_SUGGESTIONS, completionCap);
  return (
    <>
      {showCommand && (
        <CommandCompletionMenu
          above
          width={width}
          filtered={command.filtered}
          selectedIndex={command.selectedIndex}
          fuzzyMatch={command.fuzzyMatch}
          maxVisible={completionCap}
        />
      )}
      {showReference && (
        <ReferenceCompletionMenu
          above
          width={width}
          filtered={reference.filtered}
          selectedIndex={reference.selectedIndex}
          maxVisible={referenceSuggestionsCap}
        />
      )}
    </>
  );
}

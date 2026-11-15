import type { FilteredStdin } from '../../lib/terminal/filtered-stdin/types.js';
import type { TerminalSelection } from '../../lib/terminal/selection/install.js';
import type { createEditorOutput } from './editor-output.js';
import type { resolveRenderInputConfig } from './input-config.js';

/** The stream that Ink writes every frame to. */
export type EditorOutput = ReturnType<typeof createEditorOutput>;

/**
 * The input of the TUI from its start to its cleanup: the input modes, the text selection of a
 * fullscreen mouse terminal, the tap of the key debug log, and the filtered stdin that Ink reads.
 * The inline fallback replaces `stdin` in place, so the cleanup disables the input Ink reads then.
 */
export interface TuiInput {
  modes: ReturnType<typeof resolveRenderInputConfig>;
  selection: TerminalSelection | undefined;
  rawKeyTap: ((chunk: Buffer) => void) | undefined;
  stdin: FilteredStdin;
}

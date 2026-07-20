import XtermHeadless from '@xterm/headless';
import {
  FrameArtifactIdentitySchema,
  type FrameArtifactIdentity,
} from '../contracts/artifact-identity.js';
import type { CellGrid } from '../contracts/cells.js';
import { projectTerminalBuffer } from './cells.js';
import { captureTerminalHyperlinks, sanitizeTerminalFrame } from './controls.js';

export interface ParseTerminalFrameOptions {
  readonly ansi: string;
  readonly identity: FrameArtifactIdentity;
  readonly projectRoot: string;
}

export async function parseTerminalFrame(options: ParseTerminalFrameOptions): Promise<CellGrid> {
  const identity = FrameArtifactIdentitySchema.parse(options.identity);
  const { cols, rows } = identity.provenance.viewport;
  const ansi = sanitizeTerminalFrame({ ansi: options.ansi, projectRoot: options.projectRoot });
  const terminal = new XtermHeadless.Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
    disableStdin: true,
    logLevel: 'off',
    scrollback: 0,
  });
  const hyperlinks = captureTerminalHyperlinks(terminal, options.projectRoot);

  try {
    await writeTerminal(terminal, ansi);
    hyperlinks.finish();
    return projectTerminalBuffer({
      buffer: terminal.buffer.active,
      identity,
      hyperlinkAt: hyperlinks.hyperlinkAt,
    });
  } finally {
    hyperlinks.dispose();
    terminal.dispose();
  }
}

function writeTerminal(terminal: XtermHeadless.Terminal, ansi: string): Promise<void> {
  return new Promise((resolve) => terminal.write(ansi, resolve));
}

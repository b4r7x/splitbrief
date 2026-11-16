import type { IDisposable, Terminal } from '@xterm/headless';

// biome-ignore lint/suspicious/noControlCharactersInRegex: a mode reply begins with ESC.
const PASTE_MODE_REPLY = /\x1b\[\?2004;\d\$y/g;

/**
 * Sends each reply of the xterm terminal to the CLI, as a terminal does. With `pasteWord: false`
 * the terminal gives no word on bracketed paste: it drops its reply to the bracketed paste query.
 */
export function forwardTerminalReplies(
  terminal: Terminal,
  child: { write: (data: string) => void },
  pasteWord = true,
): IDisposable {
  return terminal.onData((data) => {
    const reply = pasteWord ? data : data.replace(PASTE_MODE_REPLY, '');
    if (reply !== '') child.write(reply);
  });
}

import { writeTerminalSequence } from '../terminal/control.js';
import { copyNative, tmuxLoadBuffer } from './native.js';
import { OSC52_MAX_BASE64, osc52Sequence, wrapForMultiplexer } from './osc52.js';

export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52';

export type CopyOutcome = ClipboardPath | 'unavailable';

function resolveMultiplexer(): 'tmux' | 'screen' | 'none' {
  if (process.env['TMUX']) return 'tmux';
  if (process.env['STY']) return 'screen';
  return 'none';
}

function isKittyTerminal(): boolean {
  return process.env['TERM'] === 'xterm-kitty' || process.env['TERM_PROGRAM'] === 'WezTerm';
}

export async function copyToClipboard(text: string): Promise<CopyOutcome> {
  const nativeDelivered = process.env['SSH_CONNECTION'] ? false : await copyNative(text);
  if (nativeDelivered) return 'native';
  const mux = resolveMultiplexer();
  if (mux === 'tmux' && (await tmuxLoadBuffer(text))) return 'tmux-buffer';
  // OSC-52 is a fallback-only side effect: emit it only once native and tmux have failed, so a
  // confirmed copy never also splashes an escape onto the terminal. It is fire-and-forget — many
  // terminals drop it silently — so `osc52` means "sent but unverified", never a confirmed copy. A
  // failed emit (e.g. closed stdout) is not even that, so it must not outrank an honest `unavailable`.
  if ((Buffer.byteLength(text, 'utf8') * 4) / 3 <= OSC52_MAX_BASE64) {
    const seq = osc52Sequence(text, { kitty: isKittyTerminal() });
    if (writeTerminalSequence(wrapForMultiplexer(seq, mux))) return 'osc52';
  }
  return 'unavailable';
}

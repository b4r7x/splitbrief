const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ST = `${ESC}\\`;

export const OSC52_MAX_BASE64 = 100_000;

export function osc52Sequence(text: string, opts?: { kitty?: boolean }): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const terminator = opts?.kitty ? ST : BEL;
  return `${ESC}]52;c;${b64}${terminator}`;
}

export function wrapForMultiplexer(seq: string, mux: 'tmux' | 'screen' | 'none'): string {
  if (mux === 'tmux') return `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ST}`;
  if (mux === 'screen') return `${ESC}P${seq}${ST}`;
  return seq;
}

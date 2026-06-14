interface KittyKeyboardFlags {
  mode: 'auto' | 'enabled';
  flags: ['disambiguateEscapeCodes'];
}

const KITTY_FLAG_BITS = {
  disambiguateEscapeCodes: 1,
} as const;

export function detectKittyKeyboardFlags(): KittyKeyboardFlags {
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  const mode: 'auto' | 'enabled' =
    termProgram === 'iTerm.app' || termProgram === 'zed' ? 'enabled' : 'auto';
  return { mode, flags: ['disambiguateEscapeCodes'] };
}

export function resolveKittyFlagBits(flags: KittyKeyboardFlags['flags']): number {
  let bitmask = 0;
  for (const flag of flags) bitmask |= KITTY_FLAG_BITS[flag];
  return bitmask;
}

export interface KittyKeyboardFlags {
  mode: 'auto' | 'enabled';
  flags: ['disambiguateEscapeCodes'];
}

export function detectKittyKeyboardFlags(): KittyKeyboardFlags {
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  const mode: 'auto' | 'enabled' =
    termProgram === 'iTerm.app' || termProgram === 'zed' ? 'enabled' : 'auto';
  return { mode, flags: ['disambiguateEscapeCodes'] };
}

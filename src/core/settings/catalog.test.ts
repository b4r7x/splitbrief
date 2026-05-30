import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFS } from './catalog.js';
import { createDefaultConfig } from '../config/load/load.js';
import { getConfigValue } from '../config/accessors/state.js';

// Settings whose dot-path is structurally valid but intentionally has no default
// value. They read as `undefined` on a fresh config, so a non-undefined assertion
// would spuriously fail. A typo'd id would not be in this set and still fail below.
const OPTIONAL_WITHOUT_DEFAULT = new Set(['implementer.timeout']);

describe('SETTINGS_DEFS id resolution', () => {
  const config = createDefaultConfig();

  for (const def of SETTINGS_DEFS) {
    if (def.readValue) continue;
    if (OPTIONAL_WITHOUT_DEFAULT.has(def.id)) continue;
    it(`resolves "${def.id}" via getConfigValue`, () => {
      expect(getConfigValue(config, def.id)).not.toBeUndefined();
    });
  }
});

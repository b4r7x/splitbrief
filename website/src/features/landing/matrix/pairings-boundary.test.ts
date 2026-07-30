// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

const serializePairingConfig = vi.fn(() => 'yaml');

vi.mock('./serialize-config.js', () => ({ serializePairingConfig }));

describe('pairing runtime boundary', () => {
  it('serializes only after a pairing is selected', async () => {
    const { DEFAULT_SELECTION, pairingYaml } = await import('./pairings.js');

    expect(serializePairingConfig).not.toHaveBeenCalled();
    expect(pairingYaml(DEFAULT_SELECTION)).toBe('yaml');
    expect(serializePairingConfig).toHaveBeenCalledOnce();
  });
});

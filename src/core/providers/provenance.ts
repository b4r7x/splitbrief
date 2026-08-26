/** Where a model row came from, said as a word so the fact never rides on colour alone. */
export const PROVENANCE_WORDS = [
  'Detected',
  'Stale',
  'Known',
  'Catalog',
  'Custom',
  'Default',
] as const;

export type ProvenanceWord = (typeof PROVENANCE_WORDS)[number];

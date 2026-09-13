import type { Layer } from './place';

type HeroZone = 'strip' | 'planner' | 'implementer' | 'results' | 'reviewer' | 'under';

const GLYPHS: readonly string[] = ['+', '∴'];

function whisper(pool: readonly string[], seed: number): Layer {
  return { pool, seed, opacity: { min: 0.9, max: 1 }, textGap: { x: 40, y: 0 } };
}

// The reference's hero whispers, each beside the object it annotates.
export const HERO: Readonly<Record<HeroZone, Layer>> = {
  strip: whisper(['// ideas → working software', 'const systemic = true'], 8088),
  planner: whisper(['understands\nthe big picture'], 8091),
  implementer: whisper(['executes\nwith focus'], 8092),
  results: whisper(['same tools.\nbetter results.'], 8093),
  reviewer: whisper(['validates\nkeeps the bar high'], 8094),
  under: whisper(['0x2F 0x62 0x72 0x69 0x65 0x66'], 8089),
};

export function lower(seed: number): Layer {
  return { pool: GLYPHS, seed, opacity: { min: 0.16, max: 0.28 }, textGap: { x: 24, y: 24 } };
}

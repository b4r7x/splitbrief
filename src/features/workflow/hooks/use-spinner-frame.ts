import { useEffect, useState } from 'react';
import { spinnerFrames } from '../../../lib/glyphs.js';
import { prefersReducedMotion } from '../display/reduce-motion.js';

const SPINNER_INTERVAL_MS = 120;
const REDUCED_MOTION_INTERVAL_MS = 1000;

export function useSpinnerFrame(active: boolean): { frame: string } {
  const frames = spinnerFrames();
  const reduced = prefersReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(
      () => setTick((current) => current + 1),
      reduced ? REDUCED_MOTION_INTERVAL_MS : SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [active, reduced]);

  const frame = reduced ? (frames[0] ?? '') : (frames[tick % frames.length] ?? '');
  return { frame };
}

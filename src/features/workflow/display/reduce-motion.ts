export function prefersReducedMotion(): boolean {
  return process.env.DIPTYCH_REDUCE_MOTION === '1' || process.env.REDUCE_MOTION === '1';
}

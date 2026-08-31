const REDUCE_MOTION_ENV = 'SPLITBRIEF_REDUCE_MOTION';

export function prefersReducedMotion(): boolean {
  return process.env[REDUCE_MOTION_ENV] === '1' || process.env.REDUCE_MOTION === '1';
}

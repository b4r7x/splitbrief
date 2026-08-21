import { z } from 'zod';

/**
 * The shape every cached runtime/tool version string must have before it is
 * written to or read back from a `.splitbrief` cache file: a printable,
 * bounded identifier that starts alphanumeric. Consumers compose their own
 * refinements (credential scans, for one) on top of this base.
 */
export const CacheVersionStringBaseSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

import { it } from 'vitest';

export const itUnix = process.platform === 'win32' ? it.skip : it;

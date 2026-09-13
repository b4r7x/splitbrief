import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';

/** The wordmark is one row. The rows six rows of figlet art spent belong to the lead sentence. */
export const HOME_LOGO_ROWS = 1;

export function getLogo(): string {
  return SPLITBRIEF_IDENTITY.displayName;
}

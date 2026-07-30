import { requireSiteUrl } from '../../scripts/site.js';

export function productionSiteOrigin(): string {
  return requireSiteUrl();
}

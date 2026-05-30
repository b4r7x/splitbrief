import { REQUIRED_BRIEF_SECTIONS } from '../headings.js';

export function requiredBriefSectionsProse(): string {
  return REQUIRED_BRIEF_SECTIONS.join(', ').replace(/, ([^,]+)$/, ', and $1');
}

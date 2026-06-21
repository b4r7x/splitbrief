import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function sanitizeWorkflowDisplayText(text: string): string {
  return sanitizeTerminalDisplayText(text).replace(JWT_PATTERN, '***REDACTED***');
}

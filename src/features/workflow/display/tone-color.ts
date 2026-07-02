import type { Theme } from '../../../components/theme.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ConversationRowTone } from '../conversation-rows/types.js';

export function colorForTone(tone: ConversationRowTone | undefined, theme: Theme): string {
  switch (tone) {
    case undefined:
    case 'text':
      return theme.text;
    case 'textDim':
      return theme.textDim;
    case 'accent':
      return theme.accent;
    case 'planner':
      return theme.planner;
    case 'implementer':
      return theme.implementer;
    case 'validator':
      return theme.validator;
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'error':
      return theme.error;
    case 'info':
      return theme.info;
    case 'markdownHeading':
      return theme.markdown.heading;
    case 'markdownCode':
      return theme.markdown.code;
    case 'markdownBlockquote':
      return theme.markdown.blockquote;
    case 'markdownList':
      return theme.markdown.list;
    case 'markdownRule':
      return theme.markdown.rule;
    case 'reviewFile':
      return theme.review.file;
    case 'border':
      return theme.border;
    default:
      return assertNever(tone);
  }
}

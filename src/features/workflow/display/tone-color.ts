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
    case 'markdownCodeGutter':
      return theme.markdown.codeGutter;
    case 'markdownItalic':
      return theme.markdown.italic;
    case 'markdownBlockquote':
      return theme.markdown.blockquote;
    case 'markdownList':
      return theme.markdown.list;
    case 'markdownRule':
      return theme.markdown.rule;
    case 'markdownLink':
      return theme.markdown.link;
    case 'markdownStrike':
      return theme.markdown.strike;
    case 'markdownTableBorder':
      return theme.markdown.tableBorder;
    case 'syntaxKeyword':
      return theme.syntax.keyword;
    case 'syntaxString':
      return theme.syntax.string;
    case 'syntaxComment':
      return theme.syntax.comment;
    case 'syntaxNumber':
      return theme.syntax.number;
    case 'syntaxLiteral':
      return theme.syntax.literal;
    case 'syntaxType':
      return theme.syntax.type;
    case 'syntaxFunction':
      return theme.syntax.function;
    case 'syntaxPunctuation':
      return theme.syntax.punctuation;
    case 'diffAdded':
      return theme.diff.added;
    case 'diffRemoved':
      return theme.diff.removed;
    case 'diffContext':
      return theme.diff.context;
    case 'reviewFile':
      return theme.review.file;
    case 'border':
      return theme.border;
    default:
      return assertNever(tone);
  }
}

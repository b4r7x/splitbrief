import type { Theme } from '../../../components/theme.js';
import type { CopyTone } from './copy.js';

/**
 * The one place a copy tone becomes a colour. `link` is the only name that is not a top-level
 * theme key: a file path here wears the same cyan the transcript gives it.
 */
export function summaryToneColor(tone: CopyTone, theme: Theme): string {
  switch (tone) {
    case 'textDim':
      return theme.textDim;
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'error':
      return theme.error;
    case 'link':
      return theme.markdown.link;
    default:
      return theme.text;
  }
}

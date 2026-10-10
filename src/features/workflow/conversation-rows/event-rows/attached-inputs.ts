import type { AttachedInput } from '../../../../core/schemas/attachment.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { configStore } from '../../../../stores/project/config.js';
import { getTerminalCellWidth, stripTerminalControls } from '../../../../utils/display-text.js';
import { projectRelativePathLabel } from '../../../../utils/path-links.js';
import { compositeBlock, rowsBlock, wrappedTextBlock } from '../row-block-compose.js';
import { row } from '../row-format/rows.js';
import { wrappedPrefixedRowTexts } from '../row-format/text.js';
import { wrapWidthFor } from '../row-markers.js';
import type { ConversationRowBlock } from '../types.js';

export function attachedInputsRowBlock(input: {
  keyPrefix: string;
  attachedInputs: readonly AttachedInput[];
  width: number;
}): ConversationRowBlock | null {
  if (input.attachedInputs.length === 0) return null;
  const rootDir = configStore.get().projectDir;
  return compositeBlock(input.keyPrefix, [
    wrappedTextBlock({
      keyPrefix: `${input.keyPrefix}-label`,
      text: `Attached files${SOFT_SEP}${input.attachedInputs.length}`,
      width: input.width,
      tone: 'textDim',
    }),
    ...input.attachedInputs.map((attached, index) => {
      const path =
        rootDir === '' ? attached.path : projectRelativePathLabel({ path: attached.path, rootDir });
      const prefix = `  ${attached.kind}${SOFT_SEP}`;
      const prefixWidth = getTerminalCellWidth(prefix);
      const continuation = ' '.repeat(prefixWidth);
      return rowsBlock(
        `${input.keyPrefix}-${index}`,
        wrappedPrefixedRowTexts(
          stripTerminalControls(path),
          Math.max(1, wrapWidthFor('message', input.width) - prefixWidth),
          '',
        ).map((line, offset) =>
          row({
            key: `${input.keyPrefix}-${index}-${offset}`,
            text: `${offset === 0 ? prefix : continuation}${line}`,
            tone: 'textDim',
          }),
        ),
      );
    }),
  ]);
}

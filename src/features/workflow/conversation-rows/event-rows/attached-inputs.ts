import type { AttachedInput } from '../../../../core/schemas/attachment.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { configStore } from '../../../../stores/project/config.js';
import { stripTerminalControls } from '../../../../utils/display-text.js';
import { projectRelativePathLabel } from '../../../../utils/path-links.js';
import { compositeBlock, wrappedTextBlock } from '../row-block-compose.js';
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
      return wrappedTextBlock({
        keyPrefix: `${input.keyPrefix}-${index}`,
        text: `${stripTerminalControls(path)}${SOFT_SEP}${attached.kind}`,
        width: input.width,
        tone: 'textDim',
        indent: 2,
      });
    }),
  ]);
}

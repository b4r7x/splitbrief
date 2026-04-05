import { useState } from 'react';
import { useInput } from 'ink';

export function useShellCommand(initialCommand: string, opts: {
  isActive: boolean;
  onSubmit: (cmd: string) => void;
  onCancel?: () => void;
}) {
  const [commandBuffer, setCommandBuffer] = useState(initialCommand);

  useInput((input, key) => {
    if (key.escape) {
      opts.onCancel?.();
      return;
    }
    if (key.return) {
      const cmd = commandBuffer.trim();
      if (cmd) opts.onSubmit(cmd);
      return;
    }
    if (key.backspace || key.delete) {
      setCommandBuffer(prev => prev.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setCommandBuffer(prev => prev + input);
    }
  }, { isActive: opts.isActive });

  return { commandBuffer, setCommandBuffer };
}

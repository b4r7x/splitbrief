import { spawn } from 'node:child_process';

export function openInEditor(filePath: string, onError?: (message: string) => void): Promise<void> {
  const editor = process.env.EDITOR || 'vi';
  return new Promise<void>((resolve) => {
    const child = spawn(editor, [filePath], { stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', (err) => {
      onError?.(`Failed to open editor: ${err.message}`);
      resolve();
    });
  });
}

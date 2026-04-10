import { spawn } from 'node:child_process';

export function openInEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR || 'vi';
  return new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', (err) => reject(err));
  });
}

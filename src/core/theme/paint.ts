import chalk from 'chalk';
import { error } from '../../utils/error.js';
import type { ThemeColor } from './palette.js';

export function paint(color: ThemeColor, text: string): string {
  if (color === undefined) return text;
  if (/^#[0-9a-f]{6}$/.test(color)) return chalk.hex(color)(text);
  const indexed = /^ansi256\((\d+)\)$/.exec(color);
  if (indexed) return chalk.ansi256(Number(indexed[1]))(text);
  switch (color) {
    case 'black':
    case 'red':
    case 'green':
    case 'yellow':
    case 'blue':
    case 'magenta':
    case 'cyan':
    case 'white':
    case 'gray':
    case 'redBright':
    case 'greenBright':
    case 'yellowBright':
    case 'blueBright':
    case 'magentaBright':
    case 'cyanBright':
    case 'whiteBright':
      return chalk[color](text);
    default:
      throw error('invalid-theme-color', `Invalid theme colour: ${color}`);
  }
}

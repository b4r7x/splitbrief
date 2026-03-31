import type { ThemeMode } from './types.js';

export interface Theme {
  text: string;
  textDim: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  planner: string;
  implementer: string;
  validator: string;
  border: string;
  panelBg: string;
  selectionBg: string;
  diff: {
    added: string;
    addedBg: string;
    removed: string;
    removedBg: string;
    context: string;
    contextBg: string;
  };
}

const terminalTheme: Theme = {
  text: 'white',
  textDim: 'gray',
  accent: 'cyan',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'blue',
  planner: 'magenta',
  implementer: 'cyan',
  validator: 'green',
  border: 'gray',
  panelBg: '',
  selectionBg: '#333333',
  diff: {
    added: 'green',
    addedBg: '',
    removed: 'red',
    removedBg: '',
    context: 'gray',
    contextBg: '',
  },
};

const monoTheme: Theme = {
  text: '#c0c0c0',
  textDim: '#666666',
  accent: '#7aa2f7',
  success: '#9ece6a',
  error: '#f7768e',
  warning: '#e0af68',
  info: '#7dcfff',
  planner: '#bb9af7',
  implementer: '#7dcfff',
  validator: '#9ece6a',
  border: '#3b3b3b',
  panelBg: '#1a1a1a',
  selectionBg: '#2a2a3a',
  diff: {
    added: '#4fd6be',
    addedBg: '#20303b',
    removed: '#c53b53',
    removedBg: '#37222c',
    context: '#828bb8',
    contextBg: '#141414',
  },
};

export function getTheme(mode: ThemeMode = 'terminal'): Theme {
  return mode === 'mono' ? monoTheme : terminalTheme;
}

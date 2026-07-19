export const ALL_SCREENS = ['home', 'workflow', 'summary', 'setup'] as const;
export type Screen = (typeof ALL_SCREENS)[number];

export type InputMode = 'normal' | 'review' | 'question';

export const ACTIVE_OVERLAYS = [
  'help',
  'command-palette',
  'skills',
  'settings',
  'mode-selector',
  'planner-picker',
  'implementer-picker',
  'sessions',
  'editor',
  'cost-drilldown',
] as const;
export type OverlayType = 'none' | (typeof ACTIVE_OVERLAYS)[number];

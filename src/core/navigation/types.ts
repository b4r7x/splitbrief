export type Screen = 'home' | 'workflow' | 'summary' | 'setup';
export type InputMode = 'normal' | 'review' | 'question';

export const ALL_SCREENS: readonly Screen[] = ['home', 'workflow', 'summary', 'setup'];

export type OverlayType =
  | 'none'
  | 'help'
  | 'command-palette'
  | 'skills'
  | 'settings'
  | 'mode-selector'
  | 'planner-picker'
  | 'implementer-picker'
  | 'sessions'
  | 'cost-drilldown'
  | 'plan-editor-help';

/** An overlay focus of this shape reproduces a typed filter instead of naming a row. */
const FILTER_PREFIX = 'filter:';

export interface SettingsFocus {
  initialKey: string | undefined;
  initialFilter: string | undefined;
}

/** `filter:temp`, `seat:build`, `workflow.mode`, undefined. A row key carries colons of its own. */
export function parseSettingsFocus(focus: string | undefined): SettingsFocus {
  if (focus === undefined || focus === '')
    return { initialKey: undefined, initialFilter: undefined };
  if (focus.startsWith(FILTER_PREFIX)) {
    return { initialKey: undefined, initialFilter: focus.slice(FILTER_PREFIX.length) };
  }
  return { initialKey: focus, initialFilter: undefined };
}

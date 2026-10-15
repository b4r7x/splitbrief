interface RenderInputConfig {
  useMouse: boolean;
  useHover: boolean;
  usePaste: boolean;
}

export function resolveRenderInputConfig(options: {
  fullscreen: boolean;
  mouse?: boolean | undefined;
  hover?: boolean | undefined;
}): RenderInputConfig {
  const usePaste = options.fullscreen;
  const useMouse = options.mouse !== false && options.fullscreen;
  return {
    useMouse,
    useHover: (options.hover ?? false) && useMouse,
    usePaste,
  };
}

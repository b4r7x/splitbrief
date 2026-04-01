import { useState, useEffect } from "react";
import { useStdout } from "ink";

export const BREAKPOINTS = {
  SMALL: 80,
  MEDIUM: 120,
  LARGE: 160,
};

export function useTerminalSize() {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDimensions({ cols: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  return dimensions;
}

export function useResponsiveLayout() {
  const { cols, rows } = useTerminalSize();
  
  return {
    cols,
    rows,
    isSmall: cols < BREAKPOINTS.MEDIUM,
    isMedium: cols >= BREAKPOINTS.MEDIUM && cols < BREAKPOINTS.LARGE,
    isLarge: cols >= BREAKPOINTS.LARGE,
  };
}

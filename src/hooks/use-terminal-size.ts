import { useState, useEffect } from "react";
import { useStdout } from "ink";

const MEDIUM_BREAKPOINT = 120;

function useTerminalSize() {
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
    isSmall: cols < MEDIUM_BREAKPOINT,
  };
}

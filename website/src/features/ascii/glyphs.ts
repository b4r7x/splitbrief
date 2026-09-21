export function createGlyphs(
  context: CanvasRenderingContext2D,
  palette: readonly string[],
  glyphs: readonly string[],
  ratio: number,
) {
  const atlas = context.canvas.ownerDocument.createElement('canvas');
  const width = 12;
  const height = 14;
  atlas.width = Math.ceil(width * palette.length * ratio);
  atlas.height = Math.ceil(height * glyphs.length * ratio);
  const brush = atlas.getContext('2d');
  if (!brush) throw new Error('Glyph canvas is unavailable');
  brush.setTransform(ratio, 0, 0, ratio, 0, 0);
  brush.font = '9px Departure, monospace';
  brush.textBaseline = 'top';
  for (const [row, glyph] of glyphs.entries()) {
    for (const [column, color] of palette.entries()) {
      brush.fillStyle = color;
      brush.fillText(glyph, column * width + 2, row * height + 2);
    }
  }
  return (glyph: number, tone: number, x: number, y: number) => {
    context.drawImage(
      atlas,
      tone * width * ratio,
      glyph * height * ratio,
      width * ratio,
      height * ratio,
      x - 2,
      y - 2,
      width,
      height,
    );
  };
}

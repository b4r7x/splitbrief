function ribbon(variation: number) {
  const rows: string[] = [];
  for (let row = 0; row < 36; row++) {
    let line = '';
    for (let column = 0; column < 68; column++) {
      const along = column / 67;
      const center = 26 - along * 18 + Math.sin(along * 4 + variation * 0.7) * 4;
      const taper = Math.sin(along * Math.PI);
      const distance = Math.abs(row - center);
      const contour = Math.abs(distance - Math.round(distance / 3) * 3);
      const grain = (column * 17 + row * 13 + variation * 7) % 11;
      line +=
        distance < 2 + taper * 9 && contour < 0.65 && grain > 1 ? (distance < 3 ? ':' : '.') : ' ';
    }
    rows.push(line.trimEnd());
  }
  return rows.join('\n');
}

export function mountAtmosphere(root: HTMLElement) {
  const fragments = Array.from({ length: 6 }, (_, index) => {
    const fragment = document.createElement('pre');
    fragment.className = 'ascii-drift';
    fragment.textContent = ribbon(index);
    return fragment;
  });
  root.replaceChildren(...fragments);
  return () => root.replaceChildren();
}

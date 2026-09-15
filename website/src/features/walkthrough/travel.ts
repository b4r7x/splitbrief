type Travel = { offset: number; velocity: number };

export function advanceTravel(current: Travel, target: number, deltaMs: number): Travel {
  // Critical damping keeps wheel bursts from resetting the document's velocity.
  const frequency = 1 / 85;
  const distance = current.offset - target;
  const momentum = current.velocity + distance * frequency;
  const decay = Math.exp(-frequency * deltaMs);
  const offset = target + (distance + momentum * deltaMs) * decay;
  const velocity = (current.velocity - momentum * frequency * deltaMs) * decay;

  if (Math.abs(offset - target) < 0.05 && Math.abs(velocity) < 0.001) {
    return { offset: target, velocity: 0 };
  }
  return { offset, velocity };
}

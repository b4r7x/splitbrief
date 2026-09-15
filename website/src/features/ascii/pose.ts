import type { Part } from './geometry.js';

type Pose = { spread: number; depth: number; yaw: number };

const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function detailPose(progress: number, snap = false): Pose {
  const p = snap ? (progress < 1 / 3 ? 0.16 : progress < 2 / 3 ? 0.5 : 0.83) : progress;
  const record = smooth((p - 0.16) / 0.34);
  const install = smooth((p - 0.5) / 0.33);
  return {
    spread: 0.12 * (1 - record),
    depth: 0.8 * record * (1 - install),
    yaw: (Math.PI / 18) * record * (1 - install),
  };
}

export function createPartTransform(pose: Pose, entry: number) {
  const spread = 1 + pose.spread * entry;
  const offsets = {
    left: -pose.depth * entry,
    right: pose.depth * entry,
    slash: 0.4 * pose.depth * entry,
  };
  const angle = pose.yaw * entry;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return (startX: number, startZ: number, part: Part, result: { x: number; z: number }) => {
    const x = startX * (part === 'slash' ? 1 : spread);
    const z = startZ + offsets[part];
    result.x = x * cosine + z * sine;
    result.z = z * cosine - x * sine;
  };
}

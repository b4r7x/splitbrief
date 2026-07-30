export type JackBulletVariant = 'planner' | 'implementer' | 'neutral';

export type JackBulletProps = {
  readonly variant: JackBulletVariant;
};

export function JackBullet({ variant }: JackBulletProps) {
  return <span className={`jack-bullet jack-bullet--${variant}`} aria-hidden="true" />;
}

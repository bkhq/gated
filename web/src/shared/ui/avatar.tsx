const AVATAR_PALETTE = [
  '260 50% 60%',
  '220 60% 55%',
  '195 65% 45%',
  '165 50% 42%',
  '30 80% 55%',
  '350 70% 60%',
]

export function Avatar({ name, size = 32, color }: { name: string, size?: number, color?: string }) {
  const initials = name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?'
  const hash = name.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0)
  const bg = color ?? AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
  return (
    <div
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight text-white"
      style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${bg})` }}
    >
      {initials}
    </div>
  )
}

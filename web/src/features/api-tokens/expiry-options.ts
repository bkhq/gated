const DAY_SECONDS = 86400
/** The browser clock may run ahead of the gateway's. */
const CLOCK_MARGIN_SECONDS = 60

/** Marks the option that stands for the longest lifetime the gateway allows. */
export const LONGEST_ALLOWED_PREFIX = 'max:'

/**
 * Token lifetimes a user may choose from. With a limit set by an
 * administrator, presets that reach it are dropped and the longest allowed
 * lifetime is offered instead.
 */
export function allowedExpiryValues(presets: readonly string[], maxSeconds: number | null | undefined): string[] {
  if (maxSeconds == null) {
    return [...presets]
  }
  const within = presets.filter((value) => {
    const days = /^(\d+)d$/.exec(value)
    return days !== null && Number(days[1]) * DAY_SECONDS < maxSeconds
  })
  const longest = maxSeconds > 2 * CLOCK_MARGIN_SECONDS ? maxSeconds - CLOCK_MARGIN_SECONDS : maxSeconds
  return [...within, `${LONGEST_ALLOWED_PREFIX}${longest}s`]
}

/** Locale key of the label for a value returned by `allowedExpiryValues`. */
export function expiryLabelKey(value: string): string {
  if (value.startsWith(LONGEST_ALLOWED_PREFIX)) {
    return 'profile.tokens.expiry.longestAllowed'
  }
  return `profile.tokens.expiry.${value === 'never' ? value : `d${value.slice(0, -1)}`}`
}

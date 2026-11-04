const STORAGE_KEY = 'gated.sessionLifetime'

/** The lifetime last chosen in this browser, in seconds. */
export function rememberedSessionLifetime(): number | null {
  const seconds = Number(localStorage.getItem(STORAGE_KEY))
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null
}

export function rememberSessionLifetime(seconds: number) {
  localStorage.setItem(STORAGE_KEY, String(seconds))
}

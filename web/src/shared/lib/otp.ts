/** The digits of a typed, pasted or autofilled one-time code, at most six. */
export function otpCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6)
}

/** SHA256 fingerprint of an OpenSSH public key blob, as `ssh-keygen -lf` prints it. */
export async function sha256Fingerprint(keyBase64: string): Promise<string | null> {
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(keyBase64), char => char.charCodeAt(0))
  }
  catch {
    return null
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `SHA256:${btoa(String.fromCharCode(...digest)).replace(/=+$/, '')}`
}

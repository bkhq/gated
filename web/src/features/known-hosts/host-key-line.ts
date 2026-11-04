export interface HostKey {
  key_type: string
  key_base64: string
}

const KEY_TYPE = /^(?:ssh-|ecdsa-|sk-)/

/**
 * The public key in a pasted line: an OpenSSH public key (`ssh-ed25519 AAAA…
 * comment`), a `known_hosts` entry or `ssh-keyscan` output (`host ssh-ed25519
 * AAAA…`). Returns null when the line holds no key.
 */
export function parseHostKeyLine(line: string): HostKey | null {
  const tokens = line.trim().split(/\s+/)
  const index = tokens.findIndex(token => KEY_TYPE.test(token))
  const keyBase64 = index === -1 ? undefined : tokens[index + 1]
  if (keyBase64 === undefined)
    return null
  return { key_type: tokens[index]!, key_base64: keyBase64 }
}

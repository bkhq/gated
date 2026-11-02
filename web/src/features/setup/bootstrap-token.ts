// The bootstrap token entered on the encryption screen also authorizes
// first-run setup; kept in memory only, for the next screen.
let rememberedToken = ''

export function rememberBootstrapToken(token: string): void {
  rememberedToken = token
}

export function rememberedBootstrapToken(): string {
  return rememberedToken
}

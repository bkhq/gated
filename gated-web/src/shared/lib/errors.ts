export async function stringifyError(err: unknown): Promise<string> {
  if (err instanceof Response) {
    return `API error: ${await err.text()}`
  }
  if (err != null && typeof err === 'object' && 'response' in err) {
    const response = (err as { response: Response }).response
    if (response instanceof Response) {
      return `API error: ${await response.text()}`
    }
  }
  return String(err)
}

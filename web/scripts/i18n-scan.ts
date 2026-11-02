const PLURAL_SUFFIX = /^(?:ordinal_)?(?:zero|one|two|few|many|other)$/

const CALL_PATTERN = /(?:^|[^\w$.])(?:i18n\.)?t\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1(?=\s*[,)}])/g
const TRANS_PATTERN = /<Trans\s[^>]*?i18nKey=\{?\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1(?=[\s}/>])/g

export interface KeyUsage {
  key: string
  file: string
  line: number
}

export function findKeyUsages(source: string, file: string): KeyUsage[] {
  const usages: KeyUsage[] = []
  for (const pattern of [CALL_PATTERN, TRANS_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const quote = match[1]
      const key = match[2] ?? ''
      if (!key || (quote === '`' && key.includes('${'))) {
        continue
      }
      const line = source.slice(0, match.index).split('\n').length + (match[0].startsWith('\n') ? 1 : 0)
      usages.push({ key, file, line })
    }
  }
  return usages.sort((a, b) => a.line - b.line)
}

function child(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

export function hasKey(locale: unknown, key: string): boolean {
  const parts = key.split('.')
  const last = parts.pop() ?? ''
  const parent = parts.reduce(child, locale)
  if (child(parent, last) !== undefined) {
    return true
  }
  if (!parent || typeof parent !== 'object') {
    return false
  }
  return Object.keys(parent).some(name => name.startsWith(`${last}_`) && PLURAL_SUFFIX.test(name.slice(last.length + 1)))
}

export function findMissingKeys(sources: { file: string, source: string }[], locale: unknown): KeyUsage[] {
  return sources.flatMap(({ file, source }) => findKeyUsages(source, file)).filter(usage => !hasKey(locale, usage.key))
}

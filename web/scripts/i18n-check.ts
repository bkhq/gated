import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales')
const languages = readdirSync(root).filter(name => !name.startsWith('.'))
function flatten(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key))
  }
  return [prefix]
}

const [baseLang, ...otherLanguages] = languages
if (!baseLang) {
  throw new Error('No locale directories found')
}

const namespaces = readdirSync(join(root, baseLang)).filter(file => file.endsWith('.json'))

for (const namespace of namespaces) {
  const base = JSON.parse(readFileSync(join(root, baseLang, namespace), 'utf8')) as unknown
  const baseKeys = new Set(flatten(base))
  for (const language of otherLanguages) {
    const next = JSON.parse(readFileSync(join(root, language, namespace), 'utf8')) as unknown
    const nextKeys = new Set(flatten(next))
    const missing = [...baseKeys].filter(key => !nextKeys.has(key))
    const extra = [...nextKeys].filter(key => !baseKeys.has(key))
    if (missing.length || extra.length) {
      throw new Error(`${language}/${namespace} key mismatch. missing=${missing.join(',')} extra=${extra.join(',')}`)
    }
  }
}

console.log(`i18n parity ok: ${languages.join(', ')}`)

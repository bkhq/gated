import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findMissingKeys } from './i18n-scan'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(webRoot, 'public', 'locales')
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

const srcRoot = join(webRoot, 'src')
const sources = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
  .filter(file => /\.tsx?$/.test(file) && !/\.(?:test|gen|d)\.tsx?$/.test(file))
  .map(file => ({ file: relative(webRoot, join(srcRoot, file)), source: readFileSync(join(srcRoot, file), 'utf8') }))
const baseLocale = JSON.parse(readFileSync(join(root, baseLang, 'common.json'), 'utf8')) as unknown
const missingKeys = findMissingKeys(sources, baseLocale)
if (missingKeys.length) {
  console.error(missingKeys.map(usage => `${usage.file}:${usage.line} ${usage.key}`).join('\n'))
  console.error(`${missingKeys.length} i18n key(s) used in src are missing from ${baseLang}/common.json`)
  process.exit(1)
}

console.log(`i18n parity ok: ${languages.join(', ')}; ${sources.length} source files scanned`)

import { findKeyUsages, findMissingKeys } from './i18n-scan'

const locale = {
  a11y: { targets: { loading: 'Loading' } },
  targets: {
    count_one: '{{count}} target',
    count_other: '{{count}} targets',
    detail: { overview: { group: 'Group' } },
  },
}

describe('i18n-scan', () => {
  it('collects literal keys from t, i18n.t and Trans with line numbers', () => {
    const source = [
      `const a = t('one.key')`,
      `const b = t("two.key", { x: 1 })`,
      'const c = t(`three.key`)',
      `const d = i18n.t('four.key')`,
      `const e = <Trans i18nKey="five.key" />`,
    ].join('\n')
    expect(findKeyUsages(source, 'f.tsx')).toEqual([
      { key: 'one.key', file: 'f.tsx', line: 1 },
      { key: 'two.key', file: 'f.tsx', line: 2 },
      { key: 'three.key', file: 'f.tsx', line: 3 },
      { key: 'four.key', file: 'f.tsx', line: 4 },
      { key: 'five.key', file: 'f.tsx', line: 5 },
    ])
  })

  it('skips dynamic keys and unrelated calls', () => {
    const source = [
      't(key)',
      // eslint-disable-next-line no-template-curly-in-string
      't(`targets.${name}`)',
      `t('prefix.' + name)`,
      `format('x.y')`,
      `obj.t('x.y')`,
    ].join('\n')
    expect(findKeyUsages(source, 'f.tsx')).toEqual([])
  })

  it('reports literal keys missing from the locale', () => {
    const source = `t('targets.loading')\nt('a11y.targets.loading')`
    expect(findMissingKeys([{ file: 'f.tsx', source }], locale)).toEqual([
      { key: 'targets.loading', file: 'f.tsx', line: 1 },
    ])
  })

  it('treats plural families and objects as present', () => {
    const source = `t('targets.count', { count: 2 })\nt('targets.detail', { returnObjects: true })\nt('targets.detail.overview.group')`
    expect(findMissingKeys([{ file: 'f.tsx', source }], locale)).toEqual([])
  })
})

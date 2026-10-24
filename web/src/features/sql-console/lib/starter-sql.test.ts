import { describe, expect, it } from 'vitest'
import { applyLimit, buildStarterSql } from './starter-sql'

describe('buildStarterSql', () => {
  it('quotes MySQL identifiers with backticks and appends the limit', () => {
    expect(buildStarterSql('MySql', 'shop', 'customers', 1000))
      .toBe('SELECT * FROM `shop`.`customers` LIMIT 1000;\n')
  })

  it('quotes Postgres identifiers with double quotes', () => {
    expect(buildStarterSql('Postgres', 'public', 'orders', 100))
      .toBe('SELECT * FROM "public"."orders" LIMIT 100;\n')
  })

  it('escapes embedded quote characters', () => {
    expect(buildStarterSql('MySql', 'sh`op', 'cust', 5))
      .toBe('SELECT * FROM `sh``op`.`cust` LIMIT 5;\n')
  })
})

describe('applyLimit', () => {
  it('rewrites an existing LIMIT clause to the new value', () => {
    expect(applyLimit('SELECT * FROM `t` LIMIT 1000;\n', 100))
      .toBe('SELECT * FROM `t` LIMIT 100;\n')
  })

  it('matches LIMIT case-insensitively and normalizes the keyword', () => {
    expect(applyLimit('select * from t limit 50', 5))
      .toBe('select * from t LIMIT 5')
  })

  it('leaves a query without a LIMIT clause untouched', () => {
    expect(applyLimit('SELECT * FROM t WHERE id = 1', 100))
      .toBe('SELECT * FROM t WHERE id = 1')
  })
})

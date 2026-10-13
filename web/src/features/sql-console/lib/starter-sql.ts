import type { DbKind } from '@/shared/lib/api/db-console'

/**
 * Build the `SELECT * FROM <table> LIMIT <n>` starter inserted when a table
 *  is clicked in the schema tree.
 */
export function buildStarterSql(kind: DbKind | null, schema: string, table: string, limit: number): string {
  const quoted = quoteQualified(kind, schema, table)
  return `SELECT * FROM ${quoted} LIMIT ${limit};\n`
}

/**
 * Rewrite an existing `LIMIT <n>` clause to the given limit so the editor
 *  stays in sync with the row-limit picker. Returns the input unchanged when
 *  the query has no LIMIT clause.
 */
export function applyLimit(sql: string, limit: number): string {
  if (!/\bLIMIT\s+\d+/i.test(sql))
    return sql
  return sql.replace(/\bLIMIT\s+\d+/i, `LIMIT ${limit}`)
}

function quoteQualified(kind: DbKind | null, schema: string, table: string): string {
  if (kind === 'MySql')
    return `\`${escapeBackticks(schema)}\`.\`${escapeBackticks(table)}\``
  if (kind === 'Postgres')
    return `"${escapeDoubleQuotes(schema)}"."${escapeDoubleQuotes(table)}"`
  return `${schema}.${table}`
}

function escapeBackticks(name: string): string {
  return name.replace(/`/g, '``')
}

function escapeDoubleQuotes(name: string): string {
  return name.replace(/"/g, '""')
}

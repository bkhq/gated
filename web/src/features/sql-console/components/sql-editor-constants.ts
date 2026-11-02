export const SQL_ROW_LIMITS = [1, 100, 1000, 5000, 10000] as const
export type SqlRowLimit = typeof SQL_ROW_LIMITS[number]

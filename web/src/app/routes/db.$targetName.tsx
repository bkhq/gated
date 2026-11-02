import { createFileRoute } from '@tanstack/react-router'
import { SqlConsoleRoute } from '@/features/sql-console/db-console-route'

export const Route = createFileRoute('/db/$targetName')({
  component: SqlConsoleRoute,
})

import { createFileRoute } from '@tanstack/react-router'
import { CommandRecordsPage } from '@/features/command-records/command-records-page'

export const Route = createFileRoute('/admin/command-records')({
  component: CommandRecordsPage,
})

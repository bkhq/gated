import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/admin/file-records')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/audit', search: { tab: 'files' } })
  },
})

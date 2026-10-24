import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/admin/command-records')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/audit', search: { tab: 'commands' } })
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { CommandAclPage } from '@/features/command-acl/command-acl-page'

export const Route = createFileRoute('/admin/command-acl')({
  component: CommandAclPage,
})

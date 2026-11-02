import { createFileRoute } from '@tanstack/react-router'
import { CredentialsPage } from '@/features/user/credentials-page'

export const Route = createFileRoute('/credentials')({
  component: CredentialsPage,
})

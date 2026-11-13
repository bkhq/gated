import { createFileRoute } from '@tanstack/react-router'
import { DesktopPage } from '@/features/desktop/desktop-page'

export const Route = createFileRoute('/desktop/$targetName')({
  component: DesktopPage,
})

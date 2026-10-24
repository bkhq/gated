import { createFileRoute } from '@tanstack/react-router'
import { TerminalPage } from '@/features/terminal/terminal-page'

export const Route = createFileRoute('/terminal/$kind/$targetName')({
  component: TerminalPage,
})

import { createFileRoute } from '@tanstack/react-router'

// The terminal workspace is mounted by AppLayout so open tabs survive
// navigation; this route only makes it visible.
export const Route = createFileRoute('/sessions')({
  component: () => null,
})

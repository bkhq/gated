import { createFileRoute, Outlet } from '@tanstack/react-router'

// Layout route: the list lives in `admin.sessions.index.tsx` and the detail in
// `admin.sessions.$sessionId.tsx`. This route only needs an <Outlet/> so the
// child (list or detail) actually renders.
export const Route = createFileRoute('/admin/sessions')({
  component: Outlet,
})

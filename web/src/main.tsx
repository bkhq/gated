import { createRouter, RouterProvider } from '@tanstack/react-router'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Providers } from './app/providers'

import { routeTree } from './app/routeTree.gen'
import { RouteError } from './app/shell/route-error'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/app.css'
import './i18n'

const router = createRouter({
  routeTree,
  basepath: '/ui',
  defaultPreload: 'intent',
  // Child-route errors render inside the shell's <Outlet />.
  defaultErrorComponent: RouteError,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById('root')

if (!root) {
  throw new Error('Missing root element')
}

createRoot(root).render(
  <React.StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </React.StrictMode>,
)

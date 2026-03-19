import { createBrowserRouter, Navigate } from 'react-router'
import { AdminLayout } from '@/features/admin/components/admin-layout'
import { GatewayLayout } from '@/features/gateway/components/gateway-layout'

export const router = createBrowserRouter([
  {
    path: '/@gated',
    element: <GatewayLayout />,
    children: [
      { index: true, lazy: async () => import('@/features/gateway/pages/target-list') },
      { path: 'login', lazy: async () => import('@/features/gateway/pages/login') },
      { path: 'ssh/:targetName', lazy: async () => import('@/features/gateway/pages/terminal') },
      { path: 'profile', lazy: async () => import('@/features/gateway/pages/profile') },
      { path: 'profile/credentials', lazy: async () => import('@/features/gateway/pages/profile-credentials') },
      { path: 'profile/api-tokens', lazy: async () => import('@/features/gateway/pages/profile-api-tokens') },
    ],
  },
  {
    path: '/@gated/admin',
    element: <AdminLayout />,
    children: [
      { index: true, lazy: async () => import('@/features/admin/pages/sessions') },
      { path: 'sessions/:id', lazy: async () => import('@/features/admin/pages/session-detail') },
      { path: 'recordings/:id', lazy: async () => import('@/features/admin/pages/recording') },
      { path: 'log', lazy: async () => import('@/features/admin/pages/log') },
      {
        path: 'config',
        lazy: async () => import('@/features/admin/pages/config/config-layout'),
        children: [
          { path: 'targets', lazy: async () => import('@/features/admin/pages/config/targets') },
          { path: 'targets/new', lazy: async () => import('@/features/admin/pages/config/create-target') },
          { path: 'targets/:id', lazy: async () => import('@/features/admin/pages/config/target-detail') },
          { path: 'users', lazy: async () => import('@/features/admin/pages/config/users') },
          { path: 'users/new', lazy: async () => import('@/features/admin/pages/config/create-user') },
          { path: 'users/:id', lazy: async () => import('@/features/admin/pages/config/user-detail') },
          { path: 'roles', lazy: async () => import('@/features/admin/pages/config/roles') },
          { path: 'roles/new', lazy: async () => import('@/features/admin/pages/config/create-role') },
          { path: 'roles/:id', lazy: async () => import('@/features/admin/pages/config/role-detail') },
          { path: 'tickets', lazy: async () => import('@/features/admin/pages/config/tickets') },
          { path: 'tickets/new', lazy: async () => import('@/features/admin/pages/config/create-ticket') },
          { path: 'ssh-keys', lazy: async () => import('@/features/admin/pages/config/ssh-keys') },
          { path: 'parameters', lazy: async () => import('@/features/admin/pages/config/parameters') },
          { path: 'ldap', lazy: async () => import('@/features/admin/pages/config/ldap-servers') },
          { path: 'ldap/new', lazy: async () => import('@/features/admin/pages/config/create-ldap-server') },
          { path: 'ldap/:id', lazy: async () => import('@/features/admin/pages/config/ldap-server-detail') },
          { path: 'target-groups', lazy: async () => import('@/features/admin/pages/config/target-groups') },
          { path: 'target-groups/new', lazy: async () => import('@/features/admin/pages/config/create-target-group') },
          { path: 'target-groups/:id', lazy: async () => import('@/features/admin/pages/config/target-group-detail') },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/@gated" replace />,
  },
])

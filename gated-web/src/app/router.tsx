import { createBrowserRouter, Navigate } from 'react-router'
import { AdminLayout } from '@/features/admin/components/admin-layout'
import { GatewayLayout } from '@/features/gateway/components/gateway-layout'
import { RequireAdmin, RequireAuth } from '@/shared/components/auth-guard'

export const router = createBrowserRouter([
  { path: '/ui/login', lazy: async () => import('@/features/gateway/pages/login') },
  { path: '/ui/otp', lazy: async () => import('@/features/gateway/pages/otp') },
  {
    path: '/ui',
    element: <GatewayLayout />,
    children: [
      {
        element: <RequireAuth />,
        children: [
          { index: true, handle: { breadcrumbKey: 'gateway:pages.targetList' }, lazy: async () => import('@/features/gateway/pages/target-list') },
          { path: 'ssh/:targetName', handle: { breadcrumbKey: 'gateway:pages.terminal' }, lazy: async () => import('@/features/gateway/pages/terminal') },
          { path: 'profile', handle: { breadcrumbKey: 'gateway:pages.profile' }, lazy: async () => import('@/features/gateway/pages/profile') },
          { path: 'profile/credentials', handle: { breadcrumbKey: 'gateway:pages.credentials' }, lazy: async () => import('@/features/gateway/pages/profile-credentials') },
          { path: 'profile/api-tokens', handle: { breadcrumbKey: 'gateway:pages.apiTokens' }, lazy: async () => import('@/features/gateway/pages/profile-api-tokens') },
        ],
      },
    ],
  },
  {
    path: '/ui/admin',
    element: <AdminLayout />,
    children: [
      {
        element: <RequireAdmin />,
        children: [
          { index: true, handle: { breadcrumbKey: 'admin:pages.sessions' }, lazy: async () => import('@/features/admin/pages/sessions') },
          { path: 'sessions/:id', handle: { breadcrumbKey: 'admin:pages.sessionDetail' }, lazy: async () => import('@/features/admin/pages/session-detail') },
          { path: 'recordings/:id', handle: { breadcrumbKey: 'admin:pages.recording' }, lazy: async () => import('@/features/admin/pages/recording') },
          { path: 'log', handle: { breadcrumbKey: 'admin:pages.log' }, lazy: async () => import('@/features/admin/pages/log') },
          {
            path: 'config',
            handle: { breadcrumbKey: 'admin:pages.configLayout' },
            lazy: async () => import('@/features/admin/pages/config/config-layout'),
            children: [
              { path: 'targets', handle: { breadcrumbKey: 'admin:pages.targets' }, lazy: async () => import('@/features/admin/pages/config/targets') },
              { path: 'targets/new', handle: { breadcrumbKey: 'admin:pages.createTarget' }, lazy: async () => import('@/features/admin/pages/config/create-target') },
              { path: 'targets/:id', handle: { breadcrumbKey: 'admin:pages.targetDetail' }, lazy: async () => import('@/features/admin/pages/config/target-detail') },
              { path: 'users', handle: { breadcrumbKey: 'admin:pages.users' }, lazy: async () => import('@/features/admin/pages/config/users') },
              { path: 'users/new', handle: { breadcrumbKey: 'admin:pages.createUser' }, lazy: async () => import('@/features/admin/pages/config/create-user') },
              { path: 'users/:id', handle: { breadcrumbKey: 'admin:pages.userDetail' }, lazy: async () => import('@/features/admin/pages/config/user-detail') },
              { path: 'roles', handle: { breadcrumbKey: 'admin:pages.roles' }, lazy: async () => import('@/features/admin/pages/config/roles') },
              { path: 'roles/new', handle: { breadcrumbKey: 'admin:pages.createRole' }, lazy: async () => import('@/features/admin/pages/config/create-role') },
              { path: 'roles/:id', handle: { breadcrumbKey: 'admin:pages.roleDetail' }, lazy: async () => import('@/features/admin/pages/config/role-detail') },
              { path: 'tickets', handle: { breadcrumbKey: 'admin:pages.tickets' }, lazy: async () => import('@/features/admin/pages/config/tickets') },
              { path: 'tickets/new', handle: { breadcrumbKey: 'admin:pages.createTicket' }, lazy: async () => import('@/features/admin/pages/config/create-ticket') },
              { path: 'ssh-keys', handle: { breadcrumbKey: 'admin:pages.sshKeys' }, lazy: async () => import('@/features/admin/pages/config/ssh-keys') },
              { path: 'parameters', handle: { breadcrumbKey: 'admin:pages.parameters' }, lazy: async () => import('@/features/admin/pages/config/parameters') },
              { path: 'ldap', handle: { breadcrumbKey: 'admin:pages.ldapServers' }, lazy: async () => import('@/features/admin/pages/config/ldap-servers') },
              { path: 'ldap/new', handle: { breadcrumbKey: 'admin:pages.createLdapServer' }, lazy: async () => import('@/features/admin/pages/config/create-ldap-server') },
              { path: 'ldap/:id', handle: { breadcrumbKey: 'admin:pages.ldapServerDetail' }, lazy: async () => import('@/features/admin/pages/config/ldap-server-detail') },
              { path: 'target-groups', handle: { breadcrumbKey: 'admin:pages.targetGroups' }, lazy: async () => import('@/features/admin/pages/config/target-groups') },
              { path: 'target-groups/new', handle: { breadcrumbKey: 'admin:pages.createTargetGroup' }, lazy: async () => import('@/features/admin/pages/config/create-target-group') },
              { path: 'target-groups/:id', handle: { breadcrumbKey: 'admin:pages.targetGroupDetail' }, lazy: async () => import('@/features/admin/pages/config/target-group-detail') },
            ],
          },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/ui" replace />,
  },
])

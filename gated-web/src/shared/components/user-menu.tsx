import { ChevronsUpDown, ExternalLink, LogOut, ShieldCheck, User } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useLogoutMutation } from '@/features/gateway/api'
import { Avatar, AvatarFallback } from '@/shared/components/ui/avatar'
import { Button } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import {
  SidebarMenuButton,
} from '@/shared/components/ui/sidebar'
import { useAuthStore } from '@/shared/stores/auth'

interface UserMenuProps {
  /** 'sidebar' renders as a SidebarMenuButton (for AdminLayout footer) */
  variant?: 'sidebar' | 'button'
}

export function UserMenu({ variant = 'button' }: UserMenuProps) {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const { username, isAdmin, clearAuth } = useAuthStore()
  const logoutMutation = useLogoutMutation()

  const userInitials = username != null && username !== '' ? username.slice(0, 2).toUpperCase() : 'U'

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        clearAuth()
        void navigate('/ui/login')
      },
      onError: () => {
        toast.error(t('user.logoutError'))
      },
    })
  }

  const menuContent = (
    <DropdownMenuContent
      side={variant === 'sidebar' ? 'top' : 'bottom'}
      align={variant === 'sidebar' ? 'start' : 'end'}
      className="w-56"
    >
      <DropdownMenuItem render={<Link to="/ui/profile" />}>
        <User className="mr-2 size-4" />
        {t('user.profile')}
      </DropdownMenuItem>
      {isAdmin && (
        <DropdownMenuItem render={<Link to="/ui/admin" />}>
          <ShieldCheck className="mr-2 size-4" />
          {t('user.adminPanel')}
          <ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={handleLogout} disabled={logoutMutation.isPending}>
        <LogOut className="mr-2 size-4" />
        {t('user.logout')}
      </DropdownMenuItem>
    </DropdownMenuContent>
  )

  if (variant === 'sidebar') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger render={(
          <SidebarMenuButton
            size="lg"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          />
        )}
        >
          <Avatar className="size-8 rounded-lg">
            <AvatarFallback className="rounded-lg text-xs">{userInitials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 text-left text-sm leading-tight truncate">
            <span className="font-medium">{username ?? 'Admin'}</span>
          </div>
          <ChevronsUpDown className="ml-auto size-4 shrink-0" />
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="gap-2 h-9 px-2" />}>
        <Avatar className="size-7">
          <AvatarFallback className="text-xs">{userInitials}</AvatarFallback>
        </Avatar>
        <span className="text-sm hidden sm:inline">{username}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      {menuContent}
    </DropdownMenu>
  )
}

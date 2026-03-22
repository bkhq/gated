import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { ChevronsUpDown, ExternalLink, LogOut, ShieldCheck, User } from 'lucide-react'
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
import { useLogoutMutation } from '@/features/gateway/api'

interface UserMenuProps {
  /** 'sidebar' renders as a SidebarMenuButton (for AdminLayout footer) */
  variant?: 'sidebar' | 'button'
}

export function UserMenu({ variant = 'button' }: UserMenuProps) {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const { username, isAdmin, clearAuth } = useAuthStore()
  const logoutMutation = useLogoutMutation()

  const userInitials = username ? username.slice(0, 2).toUpperCase() : 'U'

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        clearAuth()
        void navigate('/@gated/ui/login')
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
      <DropdownMenuItem asChild>
        <Link to="/@gated/ui/profile">
          <User className="mr-2 size-4" />
          {t('user.profile')}
        </Link>
      </DropdownMenuItem>
      {isAdmin && (
        <DropdownMenuItem asChild>
          <Link to="/@gated/ui/admin">
            <ShieldCheck className="mr-2 size-4" />
            {t('user.adminPanel')}
            <ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
          </Link>
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
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg text-xs">{userInitials}</AvatarFallback>
            </Avatar>
            <div className="flex-1 text-left text-sm leading-tight truncate">
              <span className="font-medium">{username ?? 'Admin'}</span>
            </div>
            <ChevronsUpDown className="ml-auto size-4 shrink-0" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 h-9 px-2">
          <Avatar className="size-7">
            <AvatarFallback className="text-xs">{userInitials}</AvatarFallback>
          </Avatar>
          <span className="text-sm hidden sm:inline">{username}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      {menuContent}
    </DropdownMenu>
  )
}

import type { ToasterProps } from 'sonner'
import { Toaster as Sonner } from 'sonner'
import { useAppStore } from '@/store/app-store'

function Toaster(props: ToasterProps) {
  const theme = useAppStore(state => state.theme)
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="top-center"
      richColors
      closeButton
      style={
        {
          '--normal-bg': 'hsl(var(--popover))',
          '--normal-text': 'hsl(var(--popover-foreground))',
          '--normal-border': 'hsl(var(--border))',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }

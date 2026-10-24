import * as React from 'react'

export function Drawer({ open, children, onClose, width = 520 }: {
  open: boolean
  children: React.ReactNode
  onClose: () => void
  width?: number
}) {
  React.useEffect(() => {
    if (!open)
      return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape')
        onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open)
    return null
  return (
    <div
      className="drawer-backdrop fixed inset-0 z-50 flex justify-end backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="page-enter h-full w-full overflow-y-auto border-l border-border bg-card text-card-foreground shadow-[-10px_0_30px_rgba(0,0,0,0.16)]"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        onClick={event => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

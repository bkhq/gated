import * as React from 'react'

export function useReturnFocusOnClose() {
  const ref = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) {
      ref.current = active
    }
    return () => {
      const target = ref.current
      ref.current = null
      if (target && document.contains(target)) {
        queueMicrotask(() => target.focus())
      }
    }
  }, [])
}

export function fieldAria(htmlFor: string, required: boolean, hasError: boolean, hasHint = false): {
  'aria-required'?: true
  'aria-describedby'?: string
} {
  const describedBy = hasError ? `${htmlFor}-error` : hasHint ? `${htmlFor}-hint` : undefined
  const out: { 'aria-required'?: true, 'aria-describedby'?: string } = {}
  if (required) {
    out['aria-required'] = true
  }
  if (describedBy) {
    out['aria-describedby'] = describedBy
  }
  return out
}

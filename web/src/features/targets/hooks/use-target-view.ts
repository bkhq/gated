import * as React from 'react'

export type TargetView = 'grid' | 'table'

const STORAGE_KEY = 'gated.targets.view'

function readView(): TargetView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'grid' ? 'grid' : 'table'
  }
  catch {
    return 'table'
  }
}

// Grid/table choice for the target lists, shared by the user and admin pages
// and kept across visits. Tables are the default, as on every other list.
export function useTargetView(): [TargetView, (view: TargetView) => void] {
  const [view, setView] = React.useState<TargetView>(readView)
  const update = React.useCallback((next: TargetView) => {
    setView(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    }
    catch {
      // Storage may be unavailable (private mode); the choice then lasts for this visit.
    }
  }, [])
  return [view, update]
}

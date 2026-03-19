import { useCallback, useSyncExternalStore } from 'react'

function subscribe(callback: () => void) {
  window.addEventListener('storage', callback)
  return () => window.removeEventListener('storage', callback)
}

export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const getSnapshot = useCallback(() => {
    const item = localStorage.getItem(key)
    return item ?? JSON.stringify(initialValue)
  }, [key, initialValue])

  const raw = useSyncExternalStore(subscribe, getSnapshot)

  const value: T = JSON.parse(raw) as T

  const setValue = useCallback((newValue: T | ((prev: T) => T)) => {
    const current = JSON.parse(localStorage.getItem(key) ?? JSON.stringify(initialValue)) as T
    const resolved = typeof newValue === 'function' ? (newValue as (prev: T) => T)(current) : newValue
    localStorage.setItem(key, JSON.stringify(resolved))
    window.dispatchEvent(new StorageEvent('storage', { key }))
  }, [key, initialValue])

  return [value, setValue]
}

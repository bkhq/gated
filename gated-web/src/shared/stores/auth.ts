import { create } from 'zustand'

export interface AuthState {
  username: string | null
  isAdmin: boolean
  isAuthenticated: boolean
  initialized: boolean
  setAuth: (username: string, isAdmin: boolean) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>(set => ({
  username: null,
  isAdmin: false,
  isAuthenticated: false,
  initialized: false,
  setAuth: (username, isAdmin) => set({ username, isAdmin, isAuthenticated: true, initialized: true }),
  clearAuth: () => set({ username: null, isAdmin: false, isAuthenticated: false, initialized: true }),
}))

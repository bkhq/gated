import { create } from 'zustand'

export interface AuthState {
  username: string | null
  isAdmin: boolean
  isAuthenticated: boolean
  setAuth: (username: string, isAdmin: boolean) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>(set => ({
  username: null,
  isAdmin: false,
  isAuthenticated: false,
  setAuth: (username, isAdmin) => set({ username, isAdmin, isAuthenticated: true }),
  clearAuth: () => set({ username: null, isAdmin: false, isAuthenticated: false }),
}))

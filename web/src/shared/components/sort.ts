export type SortDir = 'asc' | 'desc'

// Helper to compute the aria-sort value for a TH given the active sort state.
// Use alongside <SortHeader> when rendering sortable table headers.
export function ariaSort(active: boolean, dir: SortDir): 'ascending' | 'descending' | 'none' {
  if (!active) {
    return 'none'
  }
  return dir === 'asc' ? 'ascending' : 'descending'
}

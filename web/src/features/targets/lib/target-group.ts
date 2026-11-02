import type { Target } from '@/shared/types/domain'

export function targetGroupLabel(target: Pick<Target, 'groupName'>, ungrouped: string): string {
  return target.groupName || ungrouped
}

// One option per group present in `targets`, keyed by group id and sorted by
// name; ungrouped targets (empty id) come last.
export function targetGroupOptions(
  targets: Pick<Target, 'group' | 'groupName'>[],
  ungrouped: string,
): { value: string, label: string }[] {
  const names = new Map<string, string>()
  for (const target of targets)
    names.set(target.group, targetGroupLabel(target, ungrouped))
  return [...names]
    .sort(([aId, aName], [bId, bName]) => (aId === '' ? 1 : bId === '' ? -1 : aName.localeCompare(bName)))
    .map(([value, label]) => ({ value, label }))
}

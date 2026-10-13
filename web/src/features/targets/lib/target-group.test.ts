import { expect, it } from 'vitest'
import { targetGroupLabel, targetGroupOptions } from './target-group'

it('labels ungrouped targets', () => {
  expect(targetGroupLabel({ groupName: 'Production' }, 'Ungrouped')).toBe('Production')
  expect(targetGroupLabel({ groupName: '' }, 'Ungrouped')).toBe('Ungrouped')
  expect(targetGroupLabel({}, 'Ungrouped')).toBe('Ungrouped')
})

it('builds one filter option per group, keyed by id and sorted by name', () => {
  const targets = [
    { group: 'g2', groupName: 'Staging' },
    { group: '', groupName: '' },
    { group: 'g1', groupName: 'Production' },
    { group: 'g2', groupName: 'Staging' },
  ]
  expect(targetGroupOptions(targets, 'Ungrouped')).toEqual([
    { value: 'g1', label: 'Production' },
    { value: 'g2', label: 'Staging' },
    { value: '', label: 'Ungrouped' },
  ])
})

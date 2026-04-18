import { describe, expect, it } from 'bun:test';
import { composeCompositeDiffType, groupDiffOptions, parseCompositeDiffType } from './diffTypeSelection';

describe('diffTypeSelection', () => {
  it('parses encoded worktree diff types', () => {
    const diffType = composeCompositeDiffType('stack:demo', '/tmp/review-worktree');
    expect(parseCompositeDiffType(diffType)).toEqual({
      activeWorktreePath: '/tmp/review-worktree',
      activeDiffBase: 'stack:demo',
    });
  });

  it('parses legacy worktree diff types', () => {
    expect(parseCompositeDiffType('worktree:/tmp/review:branch')).toEqual({
      activeWorktreePath: '/tmp/review',
      activeDiffBase: 'branch',
    });
  });

  it('groups diff options by optgroup label', () => {
    const groups = groupDiffOptions([
      { id: 'uncommitted', label: 'Uncommitted changes' },
      { id: 'merge-base', label: 'Current PR Diff' },
      { id: 'stack:one', label: 'feature-a vs main', group: 'Stack: demo' },
      { id: 'stack:two', label: 'feature-b vs feature-a', group: 'Stack: demo' },
    ]);

    expect(groups).toEqual([
      {
        label: null,
        options: [
          { id: 'uncommitted', label: 'Uncommitted changes' },
          { id: 'merge-base', label: 'Current PR Diff' },
        ],
      },
      {
        label: 'Stack: demo',
        options: [
          { id: 'stack:one', label: 'feature-a vs main', group: 'Stack: demo' },
          { id: 'stack:two', label: 'feature-b vs feature-a', group: 'Stack: demo' },
        ],
      },
    ]);
  });
});

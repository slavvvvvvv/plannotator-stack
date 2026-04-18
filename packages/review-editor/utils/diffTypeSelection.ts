import type { DiffOption } from '@plannotator/shared/types';

const LEGACY_WORKTREE_SUB_TYPES = new Set([
  'uncommitted',
  'staged',
  'unstaged',
  'last-commit',
  'branch',
  'merge-base',
]);

export interface GroupedDiffOptions {
  label: string | null;
  options: DiffOption[];
}

export function parseCompositeDiffType(diffType: string): {
  activeWorktreePath: string | null;
  activeDiffBase: string;
} {
  if (!diffType.startsWith('worktree:')) {
    return { activeWorktreePath: null, activeDiffBase: diffType };
  }

  const rest = diffType.slice('worktree:'.length);
  const separator = rest.indexOf('::');
  if (separator !== -1) {
    return {
      activeWorktreePath: decodeURIComponent(rest.slice(0, separator)),
      activeDiffBase: decodeURIComponent(rest.slice(separator + 2)),
    };
  }

  const lastColon = rest.lastIndexOf(':');
  if (lastColon !== -1) {
    const subType = rest.slice(lastColon + 1);
    if (LEGACY_WORKTREE_SUB_TYPES.has(subType)) {
      return {
        activeWorktreePath: rest.slice(0, lastColon),
        activeDiffBase: subType,
      };
    }
  }

  return { activeWorktreePath: rest, activeDiffBase: 'uncommitted' };
}

export function composeCompositeDiffType(
  baseDiffType: string,
  worktreePath: string | null,
): string {
  if (!worktreePath) {
    return baseDiffType;
  }

  return `worktree:${encodeURIComponent(worktreePath)}::${encodeURIComponent(baseDiffType)}`;
}

export function groupDiffOptions(diffOptions: DiffOption[] | undefined): GroupedDiffOptions[] {
  if (!diffOptions || diffOptions.length === 0) {
    return [];
  }

  const groups: GroupedDiffOptions[] = [];
  for (const option of diffOptions) {
    const label = option.group ?? null;
    const existingGroup = groups.find((group) => group.label === label);
    if (existingGroup) {
      existingGroup.options.push(option);
      continue;
    }

    groups.push({ label, options: [option] });
  }

  return groups;
}

// Stepping between floors' Kanban boards, like a photo gallery's ‹ › (KanbanView.tsx). Pure, so it's easy to test.

/** The repo on the next (1) or previous (-1) floor, wrapping around; null with fewer than 2 floors or an unknown id. */
export function floorStep(repos: readonly { id: string; floor: number }[], repoId: string, step: 1 | -1): string | null {
  if (repos.length < 2) return null;
  const sorted = [...repos].sort((a, b) => a.floor - b.floor);
  const i = sorted.findIndex((r) => r.id === repoId);
  if (i === -1) return null;
  const next = sorted[(i + step + sorted.length) % sorted.length];
  return next.id;
}

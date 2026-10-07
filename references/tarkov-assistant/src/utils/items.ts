import type { ItemSearchResult } from '../types';

export type KeepVerdict = 'task' | 'hideout' | 'maybe' | 'sell';

export interface ItemVerdict {
  verdict: KeepVerdict;
  label: string;
  taskCount: number;
  foundInRaid: boolean;
  hideoutCount: number;
  hideoutUpgradeCount: number;
  hideoutCraftUses: number;
  alternativeTaskUses: number;
  reasons: string[];
}

export function judgeItem(
  item: ItemSearchResult,
  _activeTaskIds?: Set<string>,
  completedTaskIds?: Set<string>,
  completedObjectiveIds?: Set<string>,
): ItemVerdict {
  let taskCount = 0;
  let foundInRaid = false;
  let alternativeTaskUses = 0;
  const taskNames: string[] = [];
  const alternativeTaskNames: string[] = [];

  for (const task of item.usedInTasks ?? []) {
    if (completedTaskIds?.has(task.id)) continue;
    let findNeed = 0;
    let giveNeed = 0;
    let plantNeed = 0;
    for (const objective of task.objectives ?? []) {
      if (completedObjectiveIds?.has(objective.id)) continue;
      if (!objective.items?.some((candidate) => candidate.id === item.id)) continue;
      if (!['findItem', 'giveItem', 'plantItem'].includes(objective.type)) continue;
      if (objective.items.length > 1) {
        alternativeTaskUses += 1;
        if (!alternativeTaskNames.includes(task.name)) alternativeTaskNames.push(task.name);
        continue;
      }
      const count = objective.count ?? 1;
      if (objective.type === 'findItem') findNeed += count;
      if (objective.type === 'giveItem') giveNeed += count;
      if (objective.type === 'plantItem') plantNeed += count;
      foundInRaid ||= Boolean(objective.foundInRaid);
    }
    // EFT commonly represents one requirement as a find + hand-over pair. Count the larger side once.
    const taskNeed = Math.max(findNeed, giveNeed + plantNeed);
    if (taskNeed > 0) {
      taskCount += taskNeed;
      taskNames.push(`${task.trader?.name ?? 'Trader'}「${task.name}」`);
    }
  }

  const hideoutUpgradeCount = (item.craftsUsing ?? [])
    .filter((use) => use.kind === 'upgrade')
    .reduce((sum, use) => sum + Math.max(1, use.count ?? 1), 0);
  const hideoutCraftUses = (item.craftsUsing ?? []).filter((use) => use.kind !== 'upgrade').length;
  const hideoutCount = hideoutUpgradeCount || hideoutCraftUses;
  const reasons: string[] = [];
  if (taskCount) reasons.push(`${taskNames.slice(0, 3).join('、')}で合計${taskCount}個必要`);
  if (foundInRaid) reasons.push('レイド内発見（FIR）条件あり');
  if (alternativeTaskUses) {
    reasons.push(`${alternativeTaskNames.slice(0, 3).join('、')}で納品候補の1つ（他アイテムでも達成可能）`);
  }
  if (hideoutUpgradeCount) reasons.push(`Hideout構築で合計${hideoutUpgradeCount}個必要`);
  if (hideoutCraftUses) reasons.push(`クラフト${hideoutCraftUses}件の材料として使用`);

  const details = {
    taskCount,
    foundInRaid,
    hideoutCount,
    hideoutUpgradeCount,
    hideoutCraftUses,
    alternativeTaskUses,
    reasons,
  };
  if (taskCount) return { verdict: 'task', label: '捨てない：タスクで必要', ...details };
  if (hideoutCount) return { verdict: 'hideout', label: '保管推奨：Hideoutで必要', ...details };
  if (alternativeTaskUses) return { verdict: 'maybe', label: '納品候補：必要数を確認', ...details };
  if (item.usageDataComplete === false) {
    reasons.push('Hideout・クラフト用途をまだ確認できていません');
    return { verdict: 'maybe', label: '用途確認中：売却は要確認', ...details };
  }
  if ((item.avg24hPrice ?? 0) >= 50000) {
    reasons.push('フリーマーケット相場が高め');
    return { verdict: 'maybe', label: '価格を確認して判断', ...details };
  }
  reasons.push('確認できたタスク・Hideout用途なし');
  return { verdict: 'sell', label: '現時点では保持優先度低', ...details };
}

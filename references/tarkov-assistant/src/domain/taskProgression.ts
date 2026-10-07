import type { PlayerProfile, TaskData } from '../types';
import {
  createRequirementContext,
  evaluateTaskRequirementsFor,
  type RequirementCheck,
  type RequirementContext,
  type RequirementOptions,
  type RequirementEvaluation,
} from './taskRequirements';

export type TaskStatus =
  /** 完了として記録済み。 */
  | 'completed'
  /** 分岐で失敗として記録済み。 */
  | 'failed'
  /** 所持中で、必須Objectiveがすべて完了。ゲーム内でTraderへ報告する段階。 */
  | 'reportable'
  /** 所持中。 */
  | 'active'
  /** 解放済みだが所持中に入っていない。 */
  | 'available'
  /** 判定できる条件は満たしたが、自動判定できない条件が残っている。 */
  | 'needs-check'
  /** 前提タスクが未達のため未解放。 */
  | 'locked'
  /** レベル・陣営・トレーダーなどの条件が不足。 */
  | 'requirements'
  /** 分岐から外れており、もう受注できない。 */
  | 'unavailable';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  completed: '完了',
  failed: '失敗',
  reportable: '報告可能',
  active: '所持中',
  available: '受注可能',
  'needs-check': '要確認',
  locked: '未解放',
  requirements: '条件不足',
  unavailable: '受注不可',
};

export interface TaskProgressState {
  activeTaskIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  objectiveProgress: Record<string, boolean>;
  /** ユーザーが自分の意思で所持中から外したタスク。自動解放で勝手に戻さない。 */
  dismissedTaskIds?: string[];
}

export interface ReconcileResult {
  activeTaskIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  /** 今回新しく所持中へ追加されたタスク。通知に使う。 */
  newlyUnlockedTaskIds: string[];
  /** 条件は満たしたが自動判定できない条件が残るタスク。ユーザー確認待ち。 */
  needsCheckTaskIds: string[];
  /** 未判定の理由がイベント・シーズン進行であるタスク。通常プレイでは対象外。 */
  eventGatedTaskIds: string[];
  /** 陣営違いなどで受注できないため所持中から外したタスク。 */
  removedTaskIds: string[];
  changed: boolean;
}

/**
 * Objectiveの必要数。tarkov.dev の count が2以上のときだけ個数管理の対象にする。
 * 「1個」「回数指定なし」は従来どおりチェックボックス1つで扱う。
 */
export function objectiveTarget(objective: { count?: number | null }): number {
  const count = Number(objective.count);
  return Number.isFinite(count) && count > 1 ? Math.floor(count) : 1;
}

/** 個数管理するObjectiveかどうか。 */
export function isCountedObjective(objective: { count?: number | null }): boolean {
  return objectiveTarget(objective) > 1;
}

/**
 * タスクが「報告可能」かどうか。
 * 必須Objectiveが1つも無い場合は任意Objectiveを、Objective自体が無い場合は常に達成扱いとする。
 */
export function requiredObjectivesComplete(
  task: TaskData,
  objectiveProgress: Record<string, boolean>,
): boolean {
  const required = task.objectives.filter((objective) => !objective.optional);
  const checklist = required.length ? required : task.objectives;
  if (!checklist.length) return true;
  return checklist.every((objective) => Boolean(objectiveProgress[objective.id]));
}

export function taskHasRecordedProgress(
  task: TaskData,
  objectiveProgress: Record<string, boolean>,
): boolean {
  return task.objectives.some((objective) => Boolean(objectiveProgress[objective.id]));
}

export function buildContext(
  tasks: readonly TaskData[],
  progress: Pick<TaskProgressState, 'activeTaskIds' | 'completedTaskIds' | 'failedTaskIds'>,
  profile: PlayerProfile,
  options: RequirementOptions = {},
): RequirementContext {
  return createRequirementContext(tasks, progress, profile, options);
}

export function getTaskStatus(
  task: TaskData,
  context: RequirementContext,
  progress: TaskProgressState,
  evaluation?: RequirementEvaluation,
): TaskStatus {
  if (context.completedTaskIds.has(task.id)) return 'completed';
  if (context.failedTaskIds.has(task.id)) return 'failed';
  if (context.activeTaskIds.has(task.id)) {
    return requiredObjectivesComplete(task, progress.objectiveProgress) ? 'reportable' : 'active';
  }
  const result = evaluation ?? evaluateTaskRequirementsFor(task, context);
  if (result.unavailable) return 'unavailable';
  if (result.unlocked) return 'available';
  if (result.needsManualCheck) return 'needs-check';
  return result.unmetChecks.some((check) => check.kind === 'task') ? 'locked' : 'requirements';
}

/**
 * 初回起動・新規プロフィール・新しいワイプで自動的に所持中へ入れるタスク。
 * タスク名は一切ハードコードせず、tarkov.dev の taskRequirements / minPlayerLevel /
 * factionName から算出する。
 */
export function getInitialAvailableTasks(
  tasks: readonly TaskData[],
  profile: PlayerProfile,
  options: RequirementOptions = {},
): string[] {
  return reconcileTaskProgress(
    tasks,
    { activeTaskIds: [], completedTaskIds: [], failedTaskIds: [], objectiveProgress: {} },
    profile,
    options,
  ).activeTaskIds;
}

/**
 * 現在の進捗とプロフィールから、解放済みタスクを所持中へ反映する。
 *
 * - 完了・失敗として記録済みのタスクは所持中へ戻さない。
 * - 重複追加しない。
 * - 新しく解放されたタスクが別タスクの前提（status: active）を満たすことがあるため、
 *   変化が無くなるまで繰り返す。
 * - 自動判定できない条件が残るタスクは自動追加せず、`needsCheckTaskIds` として返す。
 * - 所持中から外すのは、陣営違いなど「二度と受注できない」条件に該当し、かつ
 *   Objective進捗が1つも記録されていない場合だけ。ユーザーの進捗は消さない。
 */
export function reconcileTaskProgress(
  tasks: readonly TaskData[],
  progress: TaskProgressState,
  profile: PlayerProfile,
  options: RequirementOptions = {},
): ReconcileResult {
  const taskIndex = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set(progress.completedTaskIds);
  const failed = new Set(progress.failedTaskIds);
  const dismissed = new Set(progress.dismissedTaskIds ?? []);
  const active = new Set(progress.activeTaskIds.filter((id) => !completed.has(id) && !failed.has(id)));

  // 陣営条件はプロフィールだけで決まるため、所持中の増減に影響されない。
  // 評価コンテキストはループの外で1度だけ作る。
  const removalContext = buildContext(tasks, {
    activeTaskIds: [...active],
    completedTaskIds: [...completed],
    failedTaskIds: [...failed],
  }, profile, options);
  const removedTaskIds: string[] = [];
  for (const id of [...active]) {
    const task = taskIndex.get(id);
    if (!task) continue;
    const evaluation = evaluateTaskRequirementsFor(task, removalContext);
    const blockedByFaction = evaluation.unmetChecks.some(
      (check) => check.kind === 'faction' && check.permanent === true,
    );
    if (blockedByFaction && !taskHasRecordedProgress(task, progress.objectiveProgress)) {
      active.delete(id);
      removedTaskIds.push(id);
    }
  }

  const newlyUnlockedTaskIds: string[] = [];
  let needsCheckTaskIds: string[] = [];
  let eventGatedTaskIds: string[] = [];
  for (let pass = 0; pass < 32; pass += 1) {
    const context = buildContext(tasks, {
      activeTaskIds: [...active],
      completedTaskIds: [...completed],
      failedTaskIds: [...failed],
    }, profile, options);
    const unlockedThisPass: string[] = [];
    const pendingCheck: string[] = [];
    const pendingEvent: string[] = [];
    for (const task of tasks) {
      if (active.has(task.id) || completed.has(task.id) || failed.has(task.id)) continue;
      const evaluation = evaluateTaskRequirementsFor(task, context);
      if (evaluation.unlocked) {
        if (!dismissed.has(task.id)) unlockedThisPass.push(task.id);
      } else if (evaluation.needsManualCheck && !dismissed.has(task.id)) {
        // イベント条件で止まっているものは通常の「要確認」と分けて数える。
        if (evaluation.eventGated) pendingEvent.push(task.id);
        else pendingCheck.push(task.id);
      }
    }
    needsCheckTaskIds = pendingCheck;
    eventGatedTaskIds = pendingEvent;
    if (!unlockedThisPass.length) break;
    for (const id of unlockedThisPass) {
      active.add(id);
      newlyUnlockedTaskIds.push(id);
    }
  }

  const activeTaskIds = [...active];
  return {
    activeTaskIds,
    completedTaskIds: [...completed],
    failedTaskIds: [...failed],
    newlyUnlockedTaskIds,
    needsCheckTaskIds,
    eventGatedTaskIds,
    removedTaskIds,
    changed: newlyUnlockedTaskIds.length > 0
      || removedTaskIds.length > 0
      || activeTaskIds.length !== progress.activeTaskIds.length,
  };
}

/** タスク完了を記録し、後続タスクを解放する。 */
export function completeTask(
  tasks: readonly TaskData[],
  progress: TaskProgressState,
  profile: PlayerProfile,
  taskId: string,
  options: RequirementOptions = {},
): ReconcileResult {
  const completed = new Set(progress.completedTaskIds);
  completed.add(taskId);
  const failed = new Set(progress.failedTaskIds);
  failed.delete(taskId);
  return reconcileTaskProgress(
    tasks,
    {
      ...progress,
      activeTaskIds: progress.activeTaskIds.filter((id) => id !== taskId),
      completedTaskIds: [...completed],
      failedTaskIds: [...failed],
    },
    profile,
    options,
  );
}

/** タスク完了の取り消し。後続で解放済みになったタスクはそのまま残す（進捗を消さない）。 */
export function uncompleteTask(
  tasks: readonly TaskData[],
  progress: TaskProgressState,
  profile: PlayerProfile,
  taskId: string,
  options: RequirementOptions = {},
): ReconcileResult {
  return reconcileTaskProgress(
    tasks,
    {
      ...progress,
      completedTaskIds: progress.completedTaskIds.filter((id) => id !== taskId),
      activeTaskIds: [...new Set([...progress.activeTaskIds, taskId])],
    },
    profile,
    options,
  );
}

/** 分岐タスクを失敗として記録する。 */
export function failTask(
  tasks: readonly TaskData[],
  progress: TaskProgressState,
  profile: PlayerProfile,
  taskId: string,
  options: RequirementOptions = {},
): ReconcileResult {
  const failed = new Set(progress.failedTaskIds);
  failed.add(taskId);
  return reconcileTaskProgress(
    tasks,
    {
      ...progress,
      activeTaskIds: progress.activeTaskIds.filter((id) => id !== taskId),
      completedTaskIds: progress.completedTaskIds.filter((id) => id !== taskId),
      failedTaskIds: [...failed],
    },
    profile,
    options,
  );
}

/**
 * ユーザー操作で所持中へ入れる／外す。
 * 完了済みタスクは所持中へ戻さない。外したタスクは dismissed に記録し、
 * 自動解放で即座に戻ってこないようにする。
 */
export function toggleActiveTask(
  progress: TaskProgressState,
  taskId: string,
): Pick<TaskProgressState, 'activeTaskIds' | 'dismissedTaskIds'> {
  const dismissed = new Set(progress.dismissedTaskIds ?? []);
  if (progress.completedTaskIds.includes(taskId)) {
    return { activeTaskIds: progress.activeTaskIds, dismissedTaskIds: [...dismissed] };
  }
  const active = new Set(progress.activeTaskIds);
  if (active.has(taskId)) {
    active.delete(taskId);
    dismissed.add(taskId);
  } else {
    active.add(taskId);
    dismissed.delete(taskId);
  }
  return { activeTaskIds: [...active], dismissedTaskIds: [...dismissed] };
}

export type TaskHorizon = 'current' | 'next' | 'future' | 'completed';

export const TASK_HORIZON_LABELS: Record<TaskHorizon, string> = {
  current: '現在のタスクで必要',
  next: '次に解放されるタスクで必要',
  future: '将来のタスクで必要',
  completed: '完了済みタスク',
};

/**
 * アイテム判定用に、各タスクが「いま必要」「次に解放される」「将来」のどれかを分類する。
 * 「次に解放される」は、所持中タスクをどれか1つ完了すれば解放される（＝完了後に全条件を満たす）タスク。
 */
export function classifyTaskHorizon(
  tasks: readonly TaskData[],
  progress: TaskProgressState,
  profile: PlayerProfile,
  options: RequirementOptions = {},
): Map<string, TaskHorizon> {
  const result = new Map<string, TaskHorizon>();
  const completed = new Set(progress.completedTaskIds);
  const active = new Set(progress.activeTaskIds);
  for (const task of tasks) {
    if (completed.has(task.id)) result.set(task.id, 'completed');
    else if (active.has(task.id)) result.set(task.id, 'current');
    else result.set(task.id, 'future');
  }
  for (const task of tasks) {
    if (!active.has(task.id)) continue;
    for (const preview of getNextTaskPreviews(task, tasks, progress, profile, options)) {
      if (preview.unlocksImmediately && result.get(preview.task.id) === 'future') {
        result.set(preview.task.id, 'next');
      }
    }
  }
  return result;
}

export interface NextTaskPreview {
  task: TaskData;
  /** このタスクを完了しただけで解放されるか。 */
  unlocksImmediately: boolean;
  /** 完了後もまだ足りない条件。 */
  remaining: RequirementCheck[];
  /** 自動判定できない条件が残るか。 */
  needsManualCheck: boolean;
}

/**
 * 「このタスク完了後」に解放されるタスクと、まだ足りない追加条件。
 * 前提を1つだけ見て解放するのではなく、完了後の状態で全条件を再評価する。
 */
export function getNextTaskPreviews(
  task: TaskData,
  tasks: readonly TaskData[],
  progress: TaskProgressState,
  profile: PlayerProfile,
  options: RequirementOptions = {},
): NextTaskPreview[] {
  const dependents = tasks.filter((candidate) =>
    (candidate.taskRequirements ?? []).some((requirement) => requirement.task?.id === task.id),
  );
  if (!dependents.length) return [];
  const simulated = buildContext(
    tasks,
    {
      activeTaskIds: progress.activeTaskIds.filter((id) => id !== task.id),
      completedTaskIds: [...new Set([...progress.completedTaskIds, task.id])],
      failedTaskIds: progress.failedTaskIds,
    },
    profile,
    options,
  );
  return dependents.map((candidate) => {
    const evaluation = evaluateTaskRequirementsFor(candidate, simulated);
    return {
      task: candidate,
      unlocksImmediately: evaluation.unlocked,
      remaining: [...evaluation.unmetChecks, ...evaluation.undeterminedChecks],
      needsManualCheck: evaluation.needsManualCheck,
    };
  });
}

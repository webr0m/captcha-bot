/**
 * Formato serializado de la cola de tareas (`type|chatId|param|runAt`).
 * Módulo puro para poder testear el parseo sin Redis.
 */

export type TaskType = "del" | "kick" | "lockdown" | "unlock" | "decline" | "ban" | "leave";

export interface Task {
  type: TaskType;
  chatId: number;
  param: number; // messageId para "del", userId para kick/ban/decline/leave
  runAt: number; // unix seconds
}

export const TASK_TYPES: readonly TaskType[] = [
  "del",
  "kick",
  "lockdown",
  "unlock",
  "decline",
  "ban",
  "leave",
];

export function taskToString(task: Task): string {
  return `${task.type}|${task.chatId}|${task.param}|${task.runAt}`;
}

export function parseTask(member: string): Task | null {
  const parts = String(member).split("|");
  if (parts.length !== 4 || parts.slice(1).some((part) => !/^-?\d+$/.test(part))) return null;
  const type = parts[0];
  const chatId = Number(parts[1]);
  const param = Number(parts[2]);
  const runAt = Number(parts[3]);
  if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(param) || param < 0 || !Number.isSafeInteger(runAt) || runAt < 0) return null;
  if (!TASK_TYPES.includes(type as TaskType)) return null;
  return { type: type as TaskType, chatId, param, runAt };
}

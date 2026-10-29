import test from "node:test";
import assert from "node:assert/strict";
import { parseTask, taskToString, TASK_TYPES } from "../src/lib/task_format.ts";

test("serializa y parsea una tarea de expulsión", () => {
  const task = { type: "kick", chatId: -1001234567890, param: 42, runAt: 1_700_000_000 };
  assert.equal(taskToString(task), "kick|-1001234567890|42|1700000000");
  assert.deepEqual(parseTask(taskToString(task)), task);
});

test("acepta el nuevo tipo leave y todos los tipos conocidos", () => {
  assert.equal(TASK_TYPES.includes("leave"), true);
  const task = { type: "leave", chatId: -1001, param: 0, runAt: 123 };
  assert.deepEqual(parseTask(taskToString(task)), task);
});

test("rechaza tareas corruptas o con tipo desconocido", () => {
  assert.equal(parseTask("kick|-100|42"), null);
  assert.equal(parseTask("nope|-100|42|123"), null);
  assert.equal(parseTask("kick|abc|42|123"), null);
  assert.equal(parseTask("kick|-100|42|NaN"), null);
  for (const value of ["kick|-100|42|123|extra", "kick||42|123", "kick|-100|42.5|123", "kick|-100|42|-1", "kick|-100|42|9007199254740993"]) assert.equal(parseTask(value), null);
});

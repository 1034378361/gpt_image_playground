import type { TaskRecord } from './types'
import { putTask } from './lib/db'
import { useStore } from './store'

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
  setTasks(updated)
  const task = updated.find((item) => item.id === taskId)
  if (task) void putTask(task)
}

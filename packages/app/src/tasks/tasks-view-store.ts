import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { TaskGroupBy, TaskViewMode } from "@/tasks/task-view-model";

const TASKS_VIEW_STORAGE_KEY = "tasks-view";

const PersistedTasksViewSchema = z.strictObject({
  viewMode: z.enum(["list", "board"]),
  groupBy: z.enum(["status", "label", "none"]),
});

interface TasksViewState {
  viewMode: TaskViewMode;
  groupBy: TaskGroupBy;
  setViewMode: (viewMode: TaskViewMode) => void;
  setGroupBy: (groupBy: TaskGroupBy) => void;
}

/** List/board choice and list grouping, remembered per device. */
export const useTasksViewStore = create<TasksViewState>()(
  persist(
    (set) => ({
      viewMode: "list",
      groupBy: "status",
      setViewMode: (viewMode) => set({ viewMode }),
      setGroupBy: (groupBy) => set({ groupBy }),
    }),
    {
      name: TASKS_VIEW_STORAGE_KEY,
      version: 1,
      storage: createValidatedPersistStorage(
        {
          getItem: (name) => AsyncStorage.getItem(name),
          setItem: (name, value) => AsyncStorage.setItem(name, value),
          removeItem: (name) => AsyncStorage.removeItem(name),
        },
        PersistedTasksViewSchema,
      ),
      partialize: (state) => ({ viewMode: state.viewMode, groupBy: state.groupBy }),
    },
  ),
);

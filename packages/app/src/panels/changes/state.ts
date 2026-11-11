import { z } from "zod";

export const changesStateSchema = z.strictObject({
  treeVisible: z.boolean(),
  treeWidth: z.number().optional(),
  collapsedFilePaths: z.array(z.string()),
  collapsedFolderPaths: z.array(z.string()),
  commitsCollapsed: z.boolean(),
});

export type ChangesState = z.infer<typeof changesStateSchema>;

export const defaultChangesState: ChangesState = {
  treeVisible: false,
  collapsedFilePaths: [],
  collapsedFolderPaths: [],
  commitsCollapsed: true,
};

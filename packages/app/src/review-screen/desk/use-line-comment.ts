// Pimi. PolyForm-Noncommercial-1.0.0.
// "Comment now" on a diff line: a single comment posted to the forge, pinned to the commit the
// diff is of. Null while the forge cannot take it (a worktree, an offline host, no diff yet).
import { useMemo } from "react";
import { useReviewWriteContext } from "../write/use-review-writes";
import type { FilesModel } from "./use-files-model";
import type { PostLineComment } from "./use-review-markers";

export function useLineCommentPoster(model: FilesModel): PostLineComment | null {
  const write = useReviewWriteContext();
  const createComment = write?.writes.createComment;
  const headSha = model.headSha;
  const open = model.canForgeComment && write?.connected === true && headSha !== null;
  return useMemo(
    () =>
      open && createComment && headSha
        ? ({ path, line, body, mutationId }) =>
            createComment({ mutationId, body, location: { path, side: "new", line, headSha } })
        : null,
    [createComment, headSha, open],
  );
}

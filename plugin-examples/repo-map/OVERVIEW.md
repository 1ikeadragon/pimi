Repo Map draws a workspace's repository as a treemap. Every tracked file is a box sized by its bytes and colored by how recently a commit touched it, so the biggest and most active parts of a codebase stand out. Tap a file to open it.

Open it from the sidebar, from the Command Center, or with Mod+Shift+M (rebind it in Settings, Shortcuts). Right-click a file in the file tree and choose Show in Repo Map to see where it sits. The map updates when files change.

The plugin runs `git` in the workspace directory and reads file sizes. It reads the last 500 commits for the recency colors and keeps that result on the daemon host. Repositories over 50,000 tracked files show the first 50,000 and say so on screen.

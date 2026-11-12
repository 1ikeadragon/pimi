import path from "node:path";

import { resolvePimiHome } from "../../../pimi-home.js";

const OPENCODE_HOME_DIRNAME = "opencode-home";

export function resolveOpenCodeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePimiHome(env), OPENCODE_HOME_DIRNAME);
}

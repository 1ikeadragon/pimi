import { findFragmentProblem } from "./engine.web";

/** Compiles a plugin's fragment shader when its theme registers, so a broken one fails the plugin. */
export function findShaderProblem(fragment: string): string | null {
  return findFragmentProblem(fragment);
}

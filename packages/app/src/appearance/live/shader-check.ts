// Native draws no live backdrop, so a shader has nothing to compile against there.
export function findShaderProblem(_fragment: string): string | null {
  return null;
}

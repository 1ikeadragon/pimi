import { HelperError } from "./helper-process.js";

// The main-process check on a deep link, shared by both platforms: it names a custom scheme (the
// helper then checks that the app itself registered it) and holds no control characters. Each
// platform passes the schemes that are never an app's own handler, so the tool cannot be used as a
// general URL opener.
export function checkDeeplink(url: string, notCustomSchemes: RegExp): void {
  const refuse = (message: string): never => {
    throw new HelperError("refused", message);
  };
  const match = /^([a-z][a-z0-9+.-]{1,63}):/i.exec(url);
  if (!match) refuse("A deep link starts with the app's own scheme, such as myapp://...");
  if (notCustomSchemes.test(match?.[1] ?? "")) {
    refuse(`The ${match?.[1]}: scheme is not a custom handler of the app.`);
  }
  const control = [...url].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (control) refuse("A deep link holds no control characters.");
}

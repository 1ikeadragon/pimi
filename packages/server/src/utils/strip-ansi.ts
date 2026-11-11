// The pattern from ansi-regex 6.2.2 (MIT, Sindre Sorhus). Node's util.stripVTControlCharacters is
// not a substitute: it leaves most of an OSC sequence behind when the payload holds a space or
// punctuation (window titles, OSC 8 links, OSC 7 paths) and keeps the parameters of colon SGR.
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const OSC = `(?:\\u001B\\][\\s\\S]*?${ST})`;
const CSI = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_PATTERN = new RegExp(`${OSC}|${CSI}`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

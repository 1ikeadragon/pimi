export interface PasswordsRow {
  title: string;
  url: string;
  username: string;
  password: string;
}

export type PasswordsParse =
  | { kind: "rows"; rows: PasswordsRow[] }
  | { kind: "no_password_column" };

/** RFC 4180: quoted fields may hold commas, doubled quotes and line breaks. */
export function readCsv(text: string): string[][] {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((entry) => entry.some((cell) => cell.length > 0));
}

function columnIndex(header: string[], name: string): number {
  return header.findIndex((cell) => cell.trim().toLowerCase() === name);
}

/** Apple does not document the export's columns, so they are matched by header name. */
export function parsePasswordsExport(text: string): PasswordsParse {
  const [header, ...records] = readCsv(text);
  const password = header ? columnIndex(header, "password") : -1;
  if (password === -1) return { kind: "no_password_column" };
  const title = columnIndex(header, "title");
  const url = columnIndex(header, "url");
  const username = columnIndex(header, "username");
  const cell = (record: string[], index: number): string =>
    index === -1 ? "" : (record[index] ?? "");
  const rows = records
    .map((record) => ({
      title: cell(record, title),
      url: cell(record, url),
      username: cell(record, username),
      password: cell(record, password),
    }))
    .filter((row) => row.password.length > 0);
  return { kind: "rows", rows };
}

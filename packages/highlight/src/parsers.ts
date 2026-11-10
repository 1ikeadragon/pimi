import { defineLanguageFacet, Language, StreamLanguage } from "@codemirror/language";
import { dart, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { fSharp, oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { sql } from "@codemirror/legacy-modes/mode/sql";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { parser as jsParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";
import { parser as cssParser } from "@lezer/css";
import { parser as cppParser } from "@lezer/cpp";
import { parser as goParser } from "@lezer/go";
import { parser as htmlParser } from "@lezer/html";
import { parser as javaParser } from "@lezer/java";
import { parser as pythonParser } from "@lezer/python";
import { parser as markdownParser } from "@lezer/markdown";
import { parser as phpParser } from "@lezer/php";
import { parser as rustParser } from "@lezer/rust";
import { parser as xmlParser } from "@lezer/xml";
import { parser as yamlParser } from "@lezer/yaml";
import { parser as elixirParser } from "lezer-elixir";
import type { Parser } from "@lezer/common";
import { csharpLanguage } from "./csharp/language.js";
import { astroParser } from "./astro/parser.js";
import { vueParser } from "./vue/parser.js";
import { nixLanguage } from "./nix/language.js";
import { parser as svelteBaseParser } from "./svelte/parser.js";
import { configureNesting, defaultNesting } from "./svelte/nesting.js";

function language(parser: Parser): Language {
  return new Language(defineLanguageFacet(), parser);
}

function legacy(mode: Parameters<typeof StreamLanguage.define>[0]): Language {
  return StreamLanguage.define(mode);
}

// Shared instances for languages reached through several extensions or file names.
const diffLanguage = legacy(diff);
const shellLanguage = legacy(shell);
const rubyLanguage = legacy(ruby);
const propertiesLanguage = legacy(properties);
const dockerLanguage = legacy(dockerFile);
const cmakeLanguage = legacy(cmake);

const languagesByExtension: Record<string, Language> = {
  // JavaScript/TypeScript
  js: language(jsParser),
  jsx: language(jsParser.configure({ dialect: "jsx" })),
  ts: language(jsParser.configure({ dialect: "ts" })),
  tsx: language(jsParser.configure({ dialect: "ts jsx" })),
  mjs: language(jsParser),
  cjs: language(jsParser),
  mts: language(jsParser.configure({ dialect: "ts" })),
  cts: language(jsParser.configure({ dialect: "ts" })),
  // C / C++ / Objective-C
  c: language(cppParser),
  h: language(cppParser),
  cc: language(cppParser),
  cpp: language(cppParser),
  cxx: language(cppParser),
  hpp: language(cppParser),
  hxx: language(cppParser),
  m: language(cppParser),
  mm: language(cppParser),
  // JSON
  json: language(jsonParser),
  jsonc: language(jsonParser),
  json5: language(jsonParser),
  // CSS
  css: language(cssParser),
  scss: language(cssParser),
  less: language(cssParser),
  sass: legacy(sass),
  // HTML
  html: language(htmlParser),
  htm: language(htmlParser),
  // Svelte
  svelte: language(svelteBaseParser.configure({ wrap: configureNesting(defaultNesting) })),
  // Astro
  astro: language(astroParser),
  // Vue
  vue: language(vueParser),
  // XML
  xml: language(xmlParser),
  svg: language(xmlParser),
  plist: language(xmlParser),
  // Java
  java: language(javaParser),
  // Python
  py: language(pythonParser),
  // Go
  go: language(goParser),
  // PHP
  php: language(phpParser),
  // YAML
  yaml: language(yamlParser),
  yml: language(yamlParser),
  // Rust
  rs: language(rustParser),
  // Swift
  swift: StreamLanguage.define(swift),
  // Dart
  dart: StreamLanguage.define(dart),
  // C#
  cs: csharpLanguage,
  // Nix
  nix: nixLanguage,
  // Elixir
  ex: language(elixirParser),
  exs: language(elixirParser),
  // Markdown
  md: language(markdownParser),
  mdx: language(markdownParser),
  // Diffs and patches
  diff: diffLanguage,
  patch: diffLanguage,
  // Shell
  sh: shellLanguage,
  bash: shellLanguage,
  zsh: shellLanguage,
  fish: shellLanguage,
  ksh: shellLanguage,
  // JVM
  kt: legacy(kotlin),
  kts: legacy(kotlin),
  scala: legacy(scala),
  sc: legacy(scala),
  groovy: legacy(groovy),
  gradle: legacy(groovy),
  clj: legacy(clojure),
  cljs: legacy(clojure),
  edn: legacy(clojure),
  // Scripting
  rb: rubyLanguage,
  rake: rubyLanguage,
  gemspec: rubyLanguage,
  lua: legacy(lua),
  pl: legacy(perl),
  pm: legacy(perl),
  ps1: legacy(powerShell),
  psm1: legacy(powerShell),
  r: legacy(r),
  jl: legacy(julia),
  // Functional
  hs: legacy(haskell),
  ml: legacy(oCaml),
  mli: legacy(oCaml),
  fs: legacy(fSharp),
  fsx: legacy(fSharp),
  erl: legacy(erlang),
  hrl: legacy(erlang),
  // Data, config and schemas
  sql: legacy(sql({})),
  toml: legacy(toml),
  ini: propertiesLanguage,
  cfg: propertiesLanguage,
  conf: propertiesLanguage,
  properties: propertiesLanguage,
  env: propertiesLanguage,
  proto: legacy(protobuf),
  cmake: cmakeLanguage,
  dockerfile: dockerLanguage,
};

// Files recognized by their whole name, which have no extension or a misleading one.
const languagesByFilename: Record<string, Language> = {
  dockerfile: dockerLanguage,
  containerfile: dockerLanguage,
  "cmakelists.txt": cmakeLanguage,
  gemfile: rubyLanguage,
  rakefile: rubyLanguage,
  podfile: rubyLanguage,
  ".bashrc": shellLanguage,
  ".zshrc": shellLanguage,
  ".profile": shellLanguage,
  ".bash_profile": shellLanguage,
  ".env": propertiesLanguage,
  ".gitconfig": propertiesLanguage,
  ".editorconfig": propertiesLanguage,
  "nginx.conf": legacy(nginx),
};

export function getLanguageForFile(filename: string): Language | null {
  const name = filename.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const byName =
    languagesByFilename[name] ?? (name.startsWith(".env.") ? propertiesLanguage : null);
  if (byName) return byName;
  if (name.startsWith("dockerfile.")) return dockerLanguage;
  const ext = name.includes(".") ? name.split(".").pop() : undefined;
  if (!ext) return null;
  return languagesByExtension[ext] ?? null;
}

export function getParserForFile(filename: string): Parser | null {
  return getLanguageForFile(filename)?.parser ?? null;
}

export function isLanguageSupported(filename: string): boolean {
  return getParserForFile(filename) !== null;
}

export function getSupportedExtensions(): string[] {
  return Object.keys(languagesByExtension);
}

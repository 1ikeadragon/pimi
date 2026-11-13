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

/**
 * Builds a value on first use. Each grammar is an import with a large parse table; a bundler that
 * evaluates imports where they are used (the app's web bundle) then loads a grammar only when a
 * file of that language is first highlighted.
 */
function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  let made = false;
  return () => {
    if (!made) {
      value = make();
      made = true;
    }
    return value as T;
  };
}

function language(parser: Parser): Language {
  return new Language(defineLanguageFacet(), parser);
}

function legacy(mode: Parameters<typeof StreamLanguage.define>[0]): Language {
  return StreamLanguage.define(mode);
}

// Shared instances for languages reached through several extensions or file names.
const diffLanguage = lazy(() => legacy(diff));
const shellLanguage = lazy(() => legacy(shell));
const rubyLanguage = lazy(() => legacy(ruby));
const propertiesLanguage = lazy(() => legacy(properties));
const dockerLanguage = lazy(() => legacy(dockerFile));
const cmakeLanguage = lazy(() => legacy(cmake));

const languagesByExtension: Record<string, () => Language> = {
  // JavaScript/TypeScript
  js: lazy(() => language(jsParser)),
  jsx: lazy(() => language(jsParser.configure({ dialect: "jsx" }))),
  ts: lazy(() => language(jsParser.configure({ dialect: "ts" }))),
  tsx: lazy(() => language(jsParser.configure({ dialect: "ts jsx" }))),
  mjs: lazy(() => language(jsParser)),
  cjs: lazy(() => language(jsParser)),
  mts: lazy(() => language(jsParser.configure({ dialect: "ts" }))),
  cts: lazy(() => language(jsParser.configure({ dialect: "ts" }))),
  // C / C++ / Objective-C
  c: lazy(() => language(cppParser)),
  h: lazy(() => language(cppParser)),
  cc: lazy(() => language(cppParser)),
  cpp: lazy(() => language(cppParser)),
  cxx: lazy(() => language(cppParser)),
  hpp: lazy(() => language(cppParser)),
  hxx: lazy(() => language(cppParser)),
  m: lazy(() => language(cppParser)),
  mm: lazy(() => language(cppParser)),
  // JSON
  json: lazy(() => language(jsonParser)),
  jsonc: lazy(() => language(jsonParser)),
  json5: lazy(() => language(jsonParser)),
  // CSS
  css: lazy(() => language(cssParser)),
  scss: lazy(() => language(cssParser)),
  less: lazy(() => language(cssParser)),
  sass: lazy(() => legacy(sass)),
  // HTML
  html: lazy(() => language(htmlParser)),
  htm: lazy(() => language(htmlParser)),
  // Svelte
  svelte: lazy(() =>
    language(svelteBaseParser.configure({ wrap: configureNesting(defaultNesting) })),
  ),
  // Astro
  astro: lazy(() => language(astroParser)),
  // Vue
  vue: lazy(() => language(vueParser)),
  // XML
  xml: lazy(() => language(xmlParser)),
  svg: lazy(() => language(xmlParser)),
  plist: lazy(() => language(xmlParser)),
  // Java
  java: lazy(() => language(javaParser)),
  // Python
  py: lazy(() => language(pythonParser)),
  // Go
  go: lazy(() => language(goParser)),
  // PHP
  php: lazy(() => language(phpParser)),
  // YAML
  yaml: lazy(() => language(yamlParser)),
  yml: lazy(() => language(yamlParser)),
  // Rust
  rs: lazy(() => language(rustParser)),
  // Swift
  swift: lazy(() => StreamLanguage.define(swift)),
  // Dart
  dart: lazy(() => StreamLanguage.define(dart)),
  // C#
  cs: lazy(() => csharpLanguage),
  // Nix
  nix: lazy(() => nixLanguage),
  // Elixir
  ex: lazy(() => language(elixirParser)),
  exs: lazy(() => language(elixirParser)),
  // Markdown
  md: lazy(() => language(markdownParser)),
  mdx: lazy(() => language(markdownParser)),
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
  kt: lazy(() => legacy(kotlin)),
  kts: lazy(() => legacy(kotlin)),
  scala: lazy(() => legacy(scala)),
  sc: lazy(() => legacy(scala)),
  groovy: lazy(() => legacy(groovy)),
  gradle: lazy(() => legacy(groovy)),
  clj: lazy(() => legacy(clojure)),
  cljs: lazy(() => legacy(clojure)),
  edn: lazy(() => legacy(clojure)),
  // Scripting
  rb: rubyLanguage,
  rake: rubyLanguage,
  gemspec: rubyLanguage,
  lua: lazy(() => legacy(lua)),
  pl: lazy(() => legacy(perl)),
  pm: lazy(() => legacy(perl)),
  ps1: lazy(() => legacy(powerShell)),
  psm1: lazy(() => legacy(powerShell)),
  r: lazy(() => legacy(r)),
  jl: lazy(() => legacy(julia)),
  // Functional
  hs: lazy(() => legacy(haskell)),
  ml: lazy(() => legacy(oCaml)),
  mli: lazy(() => legacy(oCaml)),
  fs: lazy(() => legacy(fSharp)),
  fsx: lazy(() => legacy(fSharp)),
  erl: lazy(() => legacy(erlang)),
  hrl: lazy(() => legacy(erlang)),
  // Data, config and schemas
  sql: lazy(() => legacy(sql({}))),
  toml: lazy(() => legacy(toml)),
  ini: propertiesLanguage,
  cfg: propertiesLanguage,
  conf: propertiesLanguage,
  properties: propertiesLanguage,
  env: propertiesLanguage,
  proto: lazy(() => legacy(protobuf)),
  cmake: cmakeLanguage,
  dockerfile: dockerLanguage,
};

// Files recognized by their whole name, which have no extension or a misleading one.
const languagesByFilename: Record<string, () => Language> = {
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
  "nginx.conf": lazy(() => legacy(nginx)),
};

export function getLanguageForFile(filename: string): Language | null {
  const name = filename.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const byName =
    languagesByFilename[name] ?? (name.startsWith(".env.") ? propertiesLanguage : null);
  if (byName) return byName();
  if (name.startsWith("dockerfile.")) return dockerLanguage();
  const ext = name.includes(".") ? name.split(".").pop() : undefined;
  if (!ext) return null;
  return languagesByExtension[ext]?.() ?? null;
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

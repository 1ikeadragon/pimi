import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envelopeSource = resolve(packageRoot, "src/validation/ws-outbound-envelope.ts");
const source = resolve(packageRoot, "codegen/generated/ws-outbound.compile.ts");
const runtimeSchemaMetadata = resolve(
  packageRoot,
  "src/generated/validation/ws-outbound-schema-metadata.ts",
);
const output = resolve(packageRoot, "src/generated/validation/ws-outbound.aot.ts");

const require = createRequire(import.meta.url);
const zodAotEntry = require.resolve("zod-aot");
const zodAotRoot = resolve(dirname(zodAotEntry), "..");
const emitterPath = resolve(zodAotRoot, "dist/cli/emitter.js");
const discriminatedUnionPath = resolve(
  zodAotRoot,
  "dist/core/codegen/schemas/discriminated-union.js",
);

async function ensureZodAotRuntimeImportExtensionPatch() {
  const emitter = await readFile(emitterPath, "utf8");
  if (emitter.includes('sourceRelPath.endsWith(".js")')) {
    return;
  }

  const before = 'let importPath = sourceRelPath.replace(/\\.[cm]?[jt]sx?$/, "");';
  const after =
    'let importPath = sourceRelPath.endsWith(".js")\n        ? sourceRelPath\n        : sourceRelPath.replace(/\\.[cm]?[jt]sx?$/, "");';
  if (!emitter.includes(before)) {
    throw new Error("zod-aot emitter shape changed; update the runtime import extension patch");
  }
  await writeFile(emitterPath, emitter.replace(before, after));
}

async function ensureZodAotDiscriminatedUnionOutputPatch() {
  let discriminatedUnionEmitter = await readFile(discriminatedUnionPath, "utf8");
  if (
    discriminatedUnionEmitter.includes(
      "const needsOutputPropagation = ir.options.some(hasMutation);",
    )
  ) {
    return;
  }

  const importBefore = 'import { escapeString } from "../context.js";';
  const importAfter = 'import { escapeString, hasMutation } from "../context.js";';
  const outputFlagBefore = "const discKey = escapeString(ir.discriminator);\n    let code = emit `";
  const outputFlagAfter =
    "const discKey = escapeString(ir.discriminator);\n    const needsOutputPropagation = ir.options.some(hasMutation);\n    let code = emit `";
  const propagationBefore =
    "        ${g.visit(option, { input: objVar, output: objVar })}\n        break;`;";
  const propagationAfter =
    '        ${g.visit(option, { input: objVar, output: objVar })}\n        ${needsOutputPropagation ? `${g.output}=${objVar};` : ""}\n        break;`;';

  if (
    !discriminatedUnionEmitter.includes(importBefore) ||
    !discriminatedUnionEmitter.includes(outputFlagBefore) ||
    !discriminatedUnionEmitter.includes(propagationBefore)
  ) {
    throw new Error("zod-aot discriminated-union emitter shape changed; update the output patch");
  }

  discriminatedUnionEmitter = discriminatedUnionEmitter
    .replace(importBefore, importAfter)
    .replace(outputFlagBefore, outputFlagAfter)
    .replace(propagationBefore, propagationAfter);
  await writeFile(discriminatedUnionPath, discriminatedUnionEmitter);
}

const STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"`;
const PATH_CHAIN = new RegExp(
  String.raw`\[(${STRING_LITERAL})\]((?:\.concat\((?:${STRING_LITERAL}|__[A-Za-z]+_\d+)\))+)`,
  "g",
);

// Issue paths are built as `["payload"].concat("a").concat(__i_3)`, one call per segment. Every
// concat argument is a string or an array index, so an array literal builds the same path.
function foldPathChains(code) {
  return code.replace(PATH_CHAIN, (_match, first, chain) => {
    const segments = [...chain.matchAll(/\.concat\((.*?)\)(?=\.concat\(|$)/g)].map((m) => m[1]);
    return `[${[first, ...segments].join(",")}]`;
  });
}

// A message validator is a boolean fast path that accepts a valid message as is, followed by a
// slow path that rebuilds the message while collecting issues. The slow path is 80% of the file.
// When the fast path exists and the slow path never builds output (no defaults, no copied
// objects), the slow path only ever runs on an invalid message, so the runtime Zod schema reports
// the issues instead. All other validators keep their slow path because a valid message goes
// through it.
function replaceSlowPathWithRuntimeSchema(code) {
  const blocks =
    /export const (SessionOutboundMessage\d+) = \/\* @__PURE__ \*\/ \(\(\) => \{\n([\s\S]*?)\n\}\)\(\);/g;
  const runtimeImports = [];
  const result = code.replace(blocks, (block, exportName, body) => {
    const lines = body.split("\n");
    const parseIndex = lines.findIndex((line) => line.startsWith("function safeParse_"));
    const slowStart = lines.findIndex((line) => line === "var _e=[];");
    const slowEnd = lines.findIndex((line) => line === "return __fin(_e,_d);");
    const fastPath = lines[parseIndex + 1] ?? "";
    const hasFastPath =
      fastPath.startsWith("if(typeof input===") &&
      fastPath.endsWith("return{success:true,data:input};}");
    if (parseIndex < 0 || slowStart !== parseIndex + 2 || slowEnd < slowStart || !hasFastPath) {
      return block;
    }
    // A default or rebuilt object means a valid message can miss the fast path and the slow path
    // builds its output.
    const slowPath = lines.slice(slowStart, slowEnd + 1).join("\n");
    if (/Object\.assign\(\{\}|\.slice\(\)|__rf\[/.test(slowPath)) return block;
    runtimeImports.push(exportName);
    const kept = [
      ...lines.slice(0, slowStart),
      `return __rt_${exportName}.schema.safeParse(input);`,
      ...lines.slice(slowEnd + 1),
    ];
    return `export const ${exportName} = /* @__PURE__ */ (() => {\n${pruneUnusedHelpers(kept).join("\n")}\n})();`;
  });
  return { code: result, runtimeImports };
}

// Drops module-level helpers of a validator that nothing references any more. Every helper the
// compiler emits is one line.
function pruneUnusedHelpers(lines) {
  const parseIndex = lines.findIndex((line) => line.startsWith("function safeParse_"));
  const helperName = (line) =>
    /^(?:function (__\w+)\(|var (__\w+)=)/.exec(line)?.slice(1).find(Boolean);
  const text = lines.join("\n");
  const unused = lines.findIndex((line, index) => {
    const name = index < parseIndex ? helperName(line) : undefined;
    return name !== undefined && text.split(new RegExp(`\\b${name}\\b`)).length === 2;
  });
  if (unused < 0) return lines;
  return pruneUnusedHelpers(lines.filter((_line, index) => index !== unused));
}

function shrinkGeneratedValidators(code, runtimeImportPath) {
  const slim = replaceSlowPathWithRuntimeSchema(code);
  const importSpecifier = runtimeImportPath.startsWith(".")
    ? runtimeImportPath
    : `./${runtimeImportPath}`;
  const runtimeImport = `import { ${slim.runtimeImports
    .map((name) => `${name} as __rt_${name}`)
    .join(", ")} } from "${importSpecifier}";`;
  const lastImport = [...slim.code.matchAll(/^import .*$/gm)].at(-1);
  const insertAt = lastImport.index + lastImport[0].length;
  const withImport = `${slim.code.slice(0, insertAt)}\n${runtimeImport}${slim.code.slice(insertAt)}`;
  return foldPathChains(withImport);
}

await Promise.all([
  ensureZodAotRuntimeImportExtensionPatch(),
  ensureZodAotDiscriminatedUnionOutputPatch(),
]);

const [
  { loadSourceFile },
  { discoverSchemas },
  { compileSchemas },
  { generateCompiledFileContent },
] = await Promise.all([
  import(pathToFileURL(resolve(zodAotRoot, "dist/loader.js")).href),
  import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
  import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
  import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
]);

// One compiled validator per session message plus a tag-only envelope. zod-aot emits one function
// per compiled schema, so this keeps every generated function small enough for V8 to optimize cheaply.
const { sessionOutboundMessageOptions } = await loadSourceFile(envelopeSource, { cacheBust: true });
const sessionTags = sessionOutboundMessageOptions.map((option) => option.shape.type.value);
function sessionExport(index) {
  return `SessionOutboundMessage${index}`;
}
const envelopeImport = relative(dirname(source), envelopeSource)
  .replace(/\.ts$/, ".js")
  .split(sep)
  .join("/");
const metadataImport = relative(dirname(runtimeSchemaMetadata), envelopeSource)
  .replace(/\.ts$/, ".js")
  .split(sep)
  .join("/");

await mkdir(dirname(source), { recursive: true });
await writeFile(
  source,
  [
    "// AUTO-GENERATED by generate-validation-aot.mjs — DO NOT EDIT",
    'import { compile } from "zod-aot";',
    `import { WSOutboundEnvelopeSchema, sessionOutboundMessageOptions } from "${envelopeImport}";`,
    "export const WSOutboundEnvelope = compile(WSOutboundEnvelopeSchema);",
    ...sessionTags.map(
      (_, index) =>
        `export const ${sessionExport(index)} = compile(sessionOutboundMessageOptions[${index}]);`,
    ),
    "",
  ].join("\n"),
);
await mkdir(dirname(runtimeSchemaMetadata), { recursive: true });
await writeFile(
  runtimeSchemaMetadata,
  [
    "// AUTO-GENERATED by generate-validation-aot.mjs — DO NOT EDIT",
    `import { WSOutboundEnvelopeSchema, sessionOutboundMessageOptions } from "${metadataImport}";`,
    "export const WSOutboundEnvelope = { schema: WSOutboundEnvelopeSchema };",
    ...sessionTags.map(
      (_, index) =>
        `export const ${sessionExport(index)} = { schema: sessionOutboundMessageOptions[${index}] };`,
    ),
    "",
  ].join("\n"),
);

const schemas = await discoverSchemas(source, { cacheBust: true });
if (schemas.length !== sessionTags.length + 1) {
  throw new Error(
    `Expected ${sessionTags.length + 1} zod-aot compile() exports in ${relative(packageRoot, source)}, found ${schemas.length}`,
  );
}

const compiled = compileSchemas(schemas, { mode: "inline" });
const runtimeImportPath = relative(dirname(output), runtimeSchemaMetadata)
  .replace(/\.[cm]?[jt]sx?$/, ".js")
  .split(sep)
  .join("/");
const content = shrinkGeneratedValidators(
  generateCompiledFileContent(compiled, runtimeImportPath, {
    zodCompat: false,
  }).replace(
    "// AUTO-GENERATED by zod-aot — DO NOT EDIT",
    "// @ts-nocheck\n// AUTO-GENERATED by zod-aot — DO NOT EDIT",
  ),
  runtimeImportPath,
);
const sessionMessageValidators = [
  "export const SessionOutboundMessageValidators = {",
  ...sessionTags.map((tag, index) => `  ${JSON.stringify(tag)}: ${sessionExport(index)},`),
  "};",
  "",
].join("\n");

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${content}\n${sessionMessageValidators}`);

console.info(
  `generated ${relative(packageRoot, output)}: envelope + ${sessionTags.length} session message validators`,
);

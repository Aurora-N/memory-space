import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const repositoryRoot = resolve(process.cwd(), readOption("--root") ?? ".");
const sourceRoot = resolve(repositoryRoot, "src");

if (!existsSync(sourceRoot)) {
  fail([`Source directory does not exist: ${sourceRoot}`]);
}

const files = collectTypeScriptFiles(sourceRoot);
const fileSet = new Set(files);
const graph = new Map(files.map((file) => [file, []]));
const violations = [];

for (const file of files) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  for (const specifier of collectLocalSpecifiers(source)) {
    const target = resolveLocalImport(file, specifier, fileSet);
    if (!target) continue;
    graph.get(file).push(target);
    checkBoundary(file, target, violations);
  }
}

checkCycles(graph, violations);

if (violations.length > 0) fail(violations);

const edgeCount = [...graph.values()].reduce((sum, edges) => sum + edges.length, 0);
console.log(`Architecture lint passed (${files.length} files, ${edgeCount} local imports).`);

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail([`${name} requires a value`]);
  return value;
}

function collectTypeScriptFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectTypeScriptFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) result.push(path);
  }
  return result.sort();
}

function resolveLocalImport(importer, specifier, candidates) {
  const base = resolve(dirname(importer), specifier);
  const paths = extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
  return paths.find((path) => candidates.has(path));
}

function collectLocalSpecifiers(source) {
  const specifiers = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

function checkBoundary(importer, target, errors) {
  const from = repositoryPath(importer);
  const to = repositoryPath(target);
  const fromLayer = layerOf(importer);
  const toLayer = layerOf(target);

  if (fromLayer === "domain" && toLayer !== "domain") {
    errors.push(`${from}: domain code must not import ${toLayer} code (${to})`);
  }

  if (fromLayer === "application" && !["application", "domain", "ports"].includes(toLayer)) {
    errors.push(`${from}: application code must depend only on application/domain/ports (${to})`);
  }

  if (fromLayer === "ports" && !["ports", "domain", "provider"].includes(toLayer)) {
    errors.push(`${from}: ports must remain implementation-neutral (${to})`);
  }

  const sqliteImplementation = to.includes("/adapters/sqlite/");
  const compositionRoot = from === "src/composition.ts" || from === "src/index.ts";
  const sqliteAdapter = from.includes("/adapters/sqlite/");
  if (sqliteImplementation && !compositionRoot && !sqliteAdapter) {
    errors.push(`${from}: only composition roots may import the SQLite implementation (${to})`);
  }

  const deliveryLayers = new Set(["binding", "cli", "http", "integration", "mcp", "provider"]);
  if (deliveryLayers.has(fromLayer) && to === "src/ports/store.ts") {
    errors.push(`${from}: delivery/integration code must use MemorySpace, not MemoryStore directly`);
  }
}

function checkCycles(graphToCheck, errors) {
  const state = new Map();
  const stack = [];
  const reported = new Set();

  function visit(file) {
    state.set(file, 1);
    stack.push(file);
    for (const target of graphToCheck.get(file) ?? []) {
      if (!graphToCheck.has(target)) continue;
      if (!state.has(target)) visit(target);
      else if (state.get(target) === 1) {
        const start = stack.indexOf(target);
        const cycle = [...stack.slice(start), target].map(repositoryPath).join(" -> ");
        if (!reported.has(cycle)) {
          reported.add(cycle);
          errors.push(`Import cycle: ${cycle}`);
        }
      }
    }
    stack.pop();
    state.set(file, 2);
  }

  for (const file of graphToCheck.keys()) if (!state.has(file)) visit(file);
}

function layerOf(file) {
  const path = relative(sourceRoot, file);
  return path.includes(sep) ? path.split(sep)[0] : "root";
}

function repositoryPath(file) {
  return relative(repositoryRoot, file).split(sep).join("/");
}

function fail(errors) {
  for (const error of errors) console.error(`architecture-lint: ${error}`);
  process.exit(1);
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const repositoryRoot = resolve(process.cwd(), readOption("--root") ?? ".");
const scanRoots = ["src", "scripts", "test", "eval", "apps/inspector/src"]
  .map((path) => resolve(repositoryRoot, path))
  .filter(existsSync);
const files = scanRoots.flatMap(collectSourceFiles).sort();
const violations = [];
const publicEntry = resolve(repositoryRoot, "src/index.ts");

for (const file of files) {
  const sourceText = readFileSync(file, "utf8");
  const displayPath = relative(repositoryRoot, file).split(sep).join("/");
  checkDirectiveComments(sourceText, displayPath, violations);

  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  checkEmptyCatchClauses(source, displayPath, violations);
  if (displayPath.startsWith("src/ports/")) {
    checkPortDocumentation(source, displayPath, violations);
  }
}

if (existsSync(publicEntry)) {
  checkPublicApiDocumentation(publicEntry, violations);
}

if (violations.length > 0) fail(violations);
console.log(`Comment policy passed (${files.length} source files).`);

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail([`${name} requires a value`]);
  return value;
}

function collectSourceFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectSourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) result.push(path);
  }
  return result;
}

function checkDirectiveComments(text, file, errors) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia
      && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const comment = scanner.getTokenText();
    const lineNumber = text.slice(0, scanner.getTokenPos()).split(/\r?\n/).length;
    if (/[\u3400-\u9fff]/u.test(comment)) {
      errors.push(`${file}:${lineNumber}: code comments must use English`);
    }
    if (/@ts-(?:expect-error|ignore)\b(?!\s+(?:--\s*)?\S.{7,})/.test(comment)) {
      errors.push(`${file}:${lineNumber}: TypeScript suppression requires a useful reason`);
    }
    if (/biome-ignore\b(?![^:]*:\s*\S.{7,})/.test(comment)) {
      errors.push(`${file}:${lineNumber}: Biome suppression requires a reason after ':'`);
    }
    const marker = comment.match(/\b(TODO|FIXME|XXX)\b(.*)$/);
    if (marker && !/^\([a-z0-9._/-]+\):\s+\S/i.test(marker[2])) {
      errors.push(
        `${file}:${lineNumber}: ${marker[1]} must use '${marker[1]}(owner-or-issue): reason'`
      );
    }
  }
}

function checkPublicApiDocumentation(entryPath, errors) {
  const entry = createSourceFile(entryPath);
  for (const statement of entry.statements) {
    if (!ts.isExportDeclaration(statement)
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.startsWith(".")) continue;
    const targetPath = resolve(dirname(entryPath), statement.moduleSpecifier.text);
    if (!existsSync(targetPath)) continue;
    const target = createSourceFile(targetPath);
    const declarations = exportedDeclarations(target);
    const names = statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text)
      : [...declarations.keys()];
    for (const name of names) {
      const declaration = declarations.get(name);
      if (!declaration || ts.getJSDocCommentsAndTags(declaration).length > 0) continue;
      const line = target.getLineAndCharacterOfPosition(declaration.getStart(target)).line + 1;
      const file = relative(repositoryRoot, targetPath).split(sep).join("/");
      errors.push(`${file}:${line}: public API '${name}' requires JSDoc`);
    }
  }
}

function createSourceFile(path) {
  const sourceText = readFileSync(path, "utf8");
  return ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function exportedDeclarations(source) {
  const declarations = new Map();
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (statement.name && isPublicContract(statement)) {
      declarations.set(statement.name.getText(source), statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declarations.set(declaration.name.text, statement);
        }
      }
    }
  }
  return declarations;
}

function checkEmptyCatchClauses(source, file, errors) {
  function visit(node) {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      const blockText = node.block.getText(source);
      if (!/\/\/[^\n}]|\/\*[\s\S]*?\*\//.test(blockText)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        errors.push(`${file}:${line}: empty catch requires a comment explaining fail-open behavior`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function checkPortDocumentation(source, file, errors) {
  for (const statement of source.statements) {
    if (!isExported(statement) || !isPortContract(statement)) continue;
    if (ts.getJSDocCommentsAndTags(statement).length > 0) continue;
    const name = statement.name?.getText(source) ?? "exported port contract";
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
    errors.push(`${file}:${line}: exported port contract '${name}' requires JSDoc`);
  }
}

function isExported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isPortContract(node) {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  );
}

function isPublicContract(node) {
  return (
    isPortContract(node)
    || ts.isFunctionDeclaration(node)
    || ts.isEnumDeclaration(node)
  );
}

function fail(errors) {
  for (const error of errors) console.error(`comment-lint: ${error}`);
  process.exit(1);
}

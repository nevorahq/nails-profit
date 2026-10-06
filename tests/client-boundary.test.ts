import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

/**
 * A server module must not import a value that is not a function from a
 * `"use client"` module.
 *
 * Next turns every export of a client module into a client reference when a
 * Server Component imports it. For a component that is the point; for a
 * constant it is a trap that makes no noise: the server receives a function
 * where it expected a string, and uses it as one. On 06.10.2026 that put the
 * source of a function into the message a studio sends its client, in place of
 * the booking link (`BOOKING_LINK_TOKEN`, now in `domain/client-return.ts`).
 *
 * The rule needs two files at once — who exports and who imports — which is
 * why it is a test over the whole tree rather than a lint rule over one file.
 */
const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib", "domain", "i18n", "db"];
const EXTENSIONS = [".ts", ".tsx"];

type Module = Readonly<{ file: string; source: ts.SourceFile; client: boolean }>;

function listSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return listSources(full);
    return EXTENSIONS.includes(path.extname(full)) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

function parse(file: string, text: string): Module {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const first = source.statements[0];
  const client =
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client";
  return { file, source, client };
}

/** Exports of a client module a server could only receive as a reference to call. */
function nonFunctionExports(unit: Module): Set<string> {
  const names = new Set<string>();
  for (const statement of unit.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      const isFunction =
        initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
      if (!isFunction && ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

function resolve(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`))]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** `server.ts imports NAME from client.tsx` for every import that is the trap. */
function violations(
  modules: readonly Module[],
  resolveImport: (fromFile: string, specifier: string) => string | null = resolve,
): string[] {
  const byFile = new Map(modules.map((unit) => [unit.file, unit]));
  const found: string[] = [];
  for (const unit of modules) {
    if (unit.client) continue;
    for (const statement of unit.source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const target = resolveImport(unit.file, (statement.moduleSpecifier as ts.StringLiteral).text);
      const exporter = target ? byFile.get(target) : undefined;
      if (!exporter?.client) continue;
      const values = nonFunctionExports(exporter);
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const name = (element.propertyName ?? element.name).text;
        if (values.has(name)) {
          found.push(`${path.relative(ROOT, unit.file)} imports ${name} from ${path.relative(ROOT, exporter.file)}`);
        }
      }
    }
  }
  return found;
}

describe("the client boundary", () => {
  test("no server module imports a constant from a client module", () => {
    const modules = SOURCE_DIRS.flatMap((dir) => listSources(path.join(ROOT, dir))).map((file) =>
      parse(file, readFileSync(file, "utf8")),
    );
    expect(violations(modules)).toEqual([]);
  });

  test("catches the shape that broke the client's message, and nothing else", () => {
    const panel = path.join(ROOT, "components/panel.tsx");
    const client = parse(
      panel,
      `"use client";\nexport const TOKEN = "__LINK__";\nexport const Panel = () => null;\nexport function helper() {}\n`,
    );
    const server = parse(
      path.join(ROOT, "app/page.tsx"),
      `import { Panel, TOKEN as LINK } from "@/components/panel";\nimport type { Thing } from "@/components/panel";\n`,
    );
    const otherClient = parse(path.join(ROOT, "components/other.tsx"), `"use client";\nimport { TOKEN } from "./panel";\n`);
    const resolveTo = (_from: string, specifier: string) =>
      specifier === "@/components/panel" || specifier === "./panel" ? panel : null;

    // The server's import of the constant is the one finding: the component
    // beside it is a reference by design, the type import is erased, and a
    // client module importing the constant receives the value itself.
    expect(violations([client, server, otherClient], resolveTo)).toEqual([
      "app/page.tsx imports TOKEN from components/panel.tsx",
    ]);
  });
});

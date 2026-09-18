import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const sourcePattern = /\.[cm]?[jt]sx?$/;
const testPattern =
  /(?:^|\/)(?:test|tests|__tests__|__mocks__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;

type Reference = { specifier: string; line: number };
type Violation = { rule: string; from: string; to: string; line: number };

function references(file: string, text: string): Reference[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result: Reference[] = [];
  const add = (value: string, node: ts.Node) => {
    result.push({
      specifier: value,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) add(argument.text, node);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal.text, node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    const file = relative(root, absolute).replaceAll("\\", "/");
    if (testPattern.test(file)) return [];
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && sourcePattern.test(file) ? [file] : [];
  });
}

// Cover the repository's relative imports, server @/ alias and workspace names.
// Computed imports and future aliases require an explicit resolver extension.
function resolveReference(from: string, specifier: string): string | undefined {
  let absolute: string;
  if (specifier.startsWith(".")) {
    absolute = resolve(root, dirname(from), specifier);
  } else if (
    from.startsWith("packages/server/") &&
    specifier.startsWith("@/")
  ) {
    absolute = resolve(root, "packages/server/src", specifier.slice(2));
  } else if (/^@yep-anywhere\/(client|server|shared)(?:\/|$)/.test(specifier)) {
    const [name, ...parts] = specifier
      .slice("@yep-anywhere/".length)
      .split("/");
    absolute = resolve(root, "packages", name ?? "", "src", ...parts);
  } else {
    return undefined;
  }
  return relative(root, absolute).replaceAll("\\", "/");
}

function violationsFor(from: string, text: string): Violation[] {
  return references(from, text).flatMap(({ specifier, line }) => {
    const to = resolveReference(from, specifier);
    if (!to) return [];
    let rule: string | undefined;
    if (
      from.startsWith("packages/server/src/services/") &&
      to.startsWith("packages/server/src/routes/")
    ) {
      rule = "services-do-not-import-routes";
    } else if (
      from.startsWith("packages/shared/src/") &&
      /^packages\/(client|server)(?:\/|$)/.test(to)
    ) {
      rule = "shared-does-not-import-applications";
    } else if (
      from.startsWith("packages/client/src/") &&
      /^packages\/server(?:\/|$)/.test(to)
    ) {
      rule = "client-does-not-import-server";
    }
    return rule ? [{ rule, from, to, line }] : [];
  });
}

const scopes = [
  "packages/server/src/services",
  "packages/shared/src",
  "packages/client/src",
];
const violations = scopes
  .flatMap((scope) => sourceFiles(resolve(root, scope)))
  .flatMap((file) =>
    violationsFor(file, readFileSync(resolve(root, file), "utf8")),
  );

describe("production dependency boundaries", () => {
  for (const rule of [
    "services-do-not-import-routes",
    "shared-does-not-import-applications",
    "client-does-not-import-server",
  ]) {
    it(rule, () => {
      expect(violations.filter((violation) => violation.rule === rule)).toEqual(
        [],
      );
    });
  }
});

describe("boundary detector regression cases", () => {
  it("detects static, type-only, re-export and literal dynamic references", () => {
    const samples = [
      'import { value } from "../routes/example.js";',
      'import type { Value } from "../routes/example.js";',
      'export { value } from "../routes/example.js";',
      'const load = () => import("../routes/example.js");',
      'const value = require("../routes/example.js");',
      'type Value = import("../routes/example.js").Value;',
      'import value = require("../routes/example.js");',
      'import { value } from "@/routes/example.js";',
    ];
    for (const text of samples) {
      expect(
        violationsFor("packages/server/src/services/example.ts", text),
      ).toHaveLength(1);
    }
  });

  it("detects relative and workspace application imports", () => {
    expect(
      violationsFor(
        "packages/shared/src/example.ts",
        'import "../../server/src/example.js";',
      ),
    ).toHaveLength(1);
    expect(
      violationsFor(
        "packages/client/src/example.ts",
        'import "@yep-anywhere/server";',
      ),
    ).toHaveLength(1);
    expect(
      violationsFor(
        "packages/shared/src/example.ts",
        'import "@yep-anywhere/client/example";',
      ),
    ).toHaveLength(1);
  });

  it("permits lower-layer dependencies and ignores comments", () => {
    expect(
      violationsFor(
        "packages/server/src/services/example.ts",
        'import "../sessions/session-model.js";',
      ),
    ).toEqual([]);
    expect(
      violationsFor(
        "packages/client/src/example.ts",
        'import "@yep-anywhere/shared";',
      ),
    ).toEqual([]);
    expect(
      violationsFor(
        "packages/server/src/services/example.ts",
        '// import "../routes/example.js";',
      ),
    ).toEqual([]);
  });
});

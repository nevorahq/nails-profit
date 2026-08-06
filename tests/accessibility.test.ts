import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The accessibility half of roadmap section 7.12, and the rules section 7.8
 * states: "все формы имеют label, inline error, error summary и видимый focus",
 * "статус нельзя передавать только цветом", "touch targets не менее 44rem".
 *
 * This reads the markup rather than rendering it. There is no renderer in this
 * repository on purpose — the logic worth testing was moved out of the
 * components instead — and a rule like "every control has a name" is a property
 * of the source, not of a particular render. What it buys is the eleventh
 * screen: the ten that exist were written to these rules by hand, and nothing
 * stopped the next one from not being. It found four unlabelled inputs and nine
 * error messages no screen reader would announce on its first run.
 *
 * It is a floor, not a certificate. Keyboard order, focus visibility and an
 * actual screen reader are checked by a person, and section 7.12 asks for that
 * separately.
 */
const SOURCE_ROOTS = ["components", "app"];

function tsxFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, found);
    else if (full.endsWith(".tsx")) found.push(full);
  }
  return found;
}

const files = SOURCE_ROOTS.flatMap((root) => tsxFiles(root));

type Finding = string;

function audit(file: string): Finding[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: Finding[] = [];
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  function attributesOf(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement) {
    const attributes = new Map<string, string>();
    for (const property of element.attributes.properties) {
      if (!ts.isJsxAttribute(property)) continue;
      const initializer = property.initializer;
      attributes.set(
        property.name.getText(),
        initializer && ts.isStringLiteral(initializer) ? initializer.text : "<expression>",
      );
    }
    return attributes;
  }

  /** Whether anything inside this element would be read out. */
  function hasText(element: ts.JsxElement) {
    let text = "";
    const collect = (node: ts.Node) => {
      if (ts.isJsxText(node)) text += node.text.trim();
      if (ts.isJsxExpression(node) && node.expression) text += "<expression>";
      ts.forEachChild(node, collect);
    };
    element.children.forEach(collect);
    return text.trim() !== "";
  }

  function visit(node: ts.Node, labelDepth: number) {
    let depth = labelDepth;
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === "label") depth += 1;

    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;

    if (opening) {
      const tag = opening.tagName.getText();
      const attributes = attributesOf(opening);
      const where = `${file}:${lineOf(opening)}`;

      if (["input", "select", "textarea"].includes(tag) && attributes.get("type") !== "hidden") {
        const named =
          depth > 0 ||
          attributes.has("aria-label") ||
          attributes.has("aria-labelledby") ||
          attributes.has("id");
        if (!named) findings.push(`${where} ${tag} has no label`);
      }

      if (tag === "button") {
        const named = ts.isJsxElement(node) ? hasText(node) : false;
        if (!named && !attributes.has("aria-label")) {
          findings.push(`${where} button has no accessible name`);
        }
      }

      // Section 7.8 asks for an inline error a client is actually told about.
      const className = attributes.get("className") ?? "";
      if (className.includes("form-error") && attributes.get("role") !== "alert") {
        findings.push(`${where} form error is not announced (role="alert")`);
      }

      if (tag === "img" && !attributes.has("alt")) findings.push(`${where} img has no alt`);
    }

    ts.forEachChild(node, (child) => visit(child, depth));
  }

  visit(source, 0);
  return findings;
}

describe("markup", () => {
  it("scans the whole interface, not a sample", () => {
    // A guard on the guard: a broken glob would make everything below pass.
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain("components/public-booking-flow.tsx");
  });

  it("gives every control a name, every error a role and every image an alt", () => {
    expect(files.flatMap(audit)).toEqual([]);
  });
});

describe("localization", () => {
  /**
   * The product name and the language endonyms. A language picker that
   * translated "Română" into Russian would be a picker nobody could use.
   */
  const ALLOWED_LITERALS = ["Nail Profit OS", "Русский", "Română", "English"];

  const clientFacing = [
    "components/public-booking-flow.tsx",
    "components/public-booking-manage.tsx",
    "components/calendar-board.tsx",
    "components/booking-setup.tsx",
  ];

  it("keeps the booking screens free of text the dictionary does not own", () => {
    const hardcoded: string[] = [];

    for (const file of clientFacing) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );

      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.text.trim();
          // Two letters or more: punctuation and separators between expressions
          // are not text anyone has to translate.
          if (/\p{L}{2,}/u.test(text) && !ALLOWED_LITERALS.includes(text)) {
            hardcoded.push(
              `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${text}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };

      visit(source);
    }

    expect(hardcoded).toEqual([]);
  });

  it("has no Russian left in the Romanian and English dictionaries", () => {
    // The failure this catches is a copy-paste during translation, which the
    // key-completeness test cannot see: the key is there, the language is not.
    const dictionary = readFileSync("i18n/dictionary.ts", "utf8");
    const romanian = dictionary.slice(dictionary.indexOf("const ro"), dictionary.indexOf("const en"));
    const english = dictionary.slice(dictionary.indexOf("const en"));

    for (const block of [romanian, english]) {
      expect([...block.matchAll(/"([^"]*[Ѐ-ӿ][^"]*)"/g)].map((match) => match[1])).toEqual([]);
    }
  });
});

describe("mobile layout", () => {
  const css = readFileSync("app/globals.css", "utf8");

  /**
   * Section 7.8 sets touch targets at 44 units under this project's `1px =
   * 1rem` scale, and names 360 px as the width the flow is checked at.
   */
  const TOUCH_TARGET_SELECTORS = [
    ".primary-button",
    ".secondary-button",
    ".danger-button",
    ".public-booking-options label",
    ".calendar-entry summary",
  ];

  it("keeps every primary control at least 44 units tall", () => {
    const tooSmall = TOUCH_TARGET_SELECTORS.filter((selector) => {
      const rule = css.match(
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*{([^}]*)}`),
      );
      const height = rule?.[1].match(/min-(?:height|width):\s*(\d+)rem/);
      return !height || Number(height[1]) < 44;
    });

    expect(tooSmall).toEqual([]);
  });

  it("has no fixed width wide enough to break a 360 px screen", () => {
    const fixed = [...css.matchAll(/[;{\s]width:\s*([^;]+);/g)]
      .map((match) => match[1].trim())
      .filter((value) => /^\d+rem$/.test(value) && Number.parseInt(value, 10) > 360);

    expect(fixed).toEqual([]);
  });
});

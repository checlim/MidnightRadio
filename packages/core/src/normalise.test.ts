import { describe, expect, it } from "vitest";
import { NORMALISER_VERSION, canonicaliseText, normaliseForComparison } from "./normalise.js";

describe("canonicaliseText", () => {
  it("keeps paragraphs, line breaks and real typography", () => {
    const src = "“Welcome to my house!”—he said.\n\nShe read: ‘Come freely.’\nAnd went…";
    expect(canonicaliseText(src)).toBe(src);
  });

  it("removes invisible characters, applies NFC and tidies spacing without touching words", () => {
    expect(canonicaliseText("  soft\u00ADhyphen  and\u00a0\u2009spaces\u200b \n  next line \r\n\r\n\r\n\r\npara  ")).toBe(
      "softhyphen and spaces\nnext line\n\npara",
    );
    expect(canonicaliseText("Ce\u0301sar")).toBe("C\u00e9sar");
  });
});

describe("normaliseForComparison", () => {
  it("folds quotes, dashes and ellipses and collapses all whitespace", () => {
    expect(normaliseForComparison("“Listen to them—the children of the night.”\n\n‘What music…’")).toBe(
      `"Listen to them-the children of the night." 'What music...'`,
    );
    expect(normaliseForComparison("pages 10–12 « bonjour » ‹ x › 5′ 6″")).toBe(`pages 10-12 " bonjour " ' x ' 5' 6"`);
  });

  it("never lower-cases, drops words or removes punctuation", () => {
    const s = "TRUE!—nervous—very, very dreadfully nervous I had been and am; but why will you say that I am mad?";
    const n = normaliseForComparison(s);
    expect(n).toBe("TRUE!-nervous-very, very dreadfully nervous I had been and am; but why will you say that I am mad?");
    expect(n.replace(/[-\s]/g, "").length).toBe(s.replace(/[—\s]/g, "").length);
  });

  it("matches the same line written with different typography", () => {
    const source = "“I am Dracula; and I bid you welcome, Mr. Harker, to my house.”";
    const script = '"I am Dracula; and I bid you welcome, Mr. Harker, to my house."';
    expect(normaliseForComparison(source)).toBe(normaliseForComparison(script));
  });

  it("agrees with canonical text, and is versioned", () => {
    const s = " a\u00ADb\u2014c\n\n“d”  ";
    expect(normaliseForComparison(canonicaliseText(s))).toBe(normaliseForComparison(s));
    expect(NORMALISER_VERSION).toMatch(/^norm-\d+$/);
  });
});

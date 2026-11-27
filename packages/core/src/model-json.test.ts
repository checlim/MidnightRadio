import { describe, expect, it } from "vitest";
import { parseModelJson } from "./model-json.js";

describe("parsing a model's JSON reply", () => {
  it("reads plain JSON as is", () => {
    expect(parseModelJson('{"characters": []}', "characters")).toEqual({ characters: [] });
    expect(parseModelJson('  {"a": 1}\n')).toEqual({ a: 1 });
  });

  it("reads a bare array as the expected list, only when told which key it is", () => {
    expect(parseModelJson('[{"name": "Count Dracula"}]', "characters")).toEqual({ characters: [{ name: "Count Dracula" }] });
    expect(parseModelJson("[1, 2]")).toEqual([1, 2]); // no key: left as it is, so the schema refuses it
  });

  it("unwraps a Markdown code fence, with or without a language", () => {
    expect(parseModelJson('```json\n{"voices": []}\n```', "voices")).toEqual({ voices: [] });
    expect(parseModelJson('```\n[{"name": "Mina"}]\n```', "voices")).toEqual({ voices: [{ name: "Mina" }] });
    expect(parseModelJson('\uFEFF```JSON\r\n{"a": 1}\r\n```')).toEqual({ a: 1 });
  });

  it("guesses nothing else: prose around the JSON, or several fences, is not JSON", () => {
    for (const text of ['Here you go: {"a": 1}', '{"a": 1} Hope this helps!', '```json\n{"a": 1}\n```\n```json\n{"b": 2}\n```', "", "not json"]) {
      expect(() => parseModelJson(text, "characters")).toThrow(SyntaxError);
    }
  });
});

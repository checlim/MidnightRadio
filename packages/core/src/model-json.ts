/**
 * Parse a model's JSON reply. Some OpenAI-compatible providers do not enforce the JSON schema the
 * request asks for, and their models then wrap or reshape otherwise good replies. Two unambiguous
 * variants are accepted so they do not cost a repair call each:
 * - the JSON inside a Markdown code fence (```json … ```);
 * - when `arrayKey` is given, a bare top-level array, read as `{ [arrayKey]: array }`.
 * Nothing else is guessed (no JSON pulled out of prose). The result is untrusted: always validate
 * it with the reply's Zod schema. Throws SyntaxError if the reply is not JSON.
 */
export function parseModelJson(text: string, arrayKey?: string): unknown {
  let body = text.replace(/^\uFEFF/, "").trim();
  const fenced = /^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  const json: unknown = JSON.parse(body);
  return arrayKey !== undefined && Array.isArray(json) ? { [arrayKey]: json } : json;
}

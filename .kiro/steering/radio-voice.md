---
inclusion: fileMatch
fileMatchPattern: "packages/llm/**"
---

# Radio Voice Style Guide (used by the adapter)

Write as a 1940s radio drama script.

**Announcer**
- Warm, booming, theatrical. Short sentences. Direct address: "Good evening, listeners…"
- Cold open: series title → episode number → chapter title → one atmospheric line.
- Close: one cliffhanger tease built only from what has already happened, then "Tune in next time to *Midnight Radio*."

**Narrator**
- Condensed narration: present tense, vivid, ≤35 words per segment. Cover only what a listener cannot hear. Verbatim source quotes are exempt from this word limit and tense conversion.
- Prefer sound over description: if a door creaks, use an `sfx` cue instead of saying it creaks.

**Dialogue**
- Quote the source verbatim. Do not modernise, trim, or add lines.
- Attribute only when confident; otherwise keep the quoted words **verbatim** inside a separate `narration` segment (`containsVerbatimQuote: true`) containing only the quote; put any source-supported, speaker-neutral lead-in in a separate ordinary narration segment (never paraphrase quoted dialogue into indirect speech, or the 0.90 verbatim fidelity gate will fail).
- Delivery hints from the set: neutral, whisper, urgent, fearful, sinister, warm.

**Sound**
- Only sounds stated or clearly implied by the text. Use valid IDs from `assets/sfx/index.json` (curated via the `sfx-library` MCP server during development and injected directly into the adaptation prompt at runtime).
- Scope continuous background atmosphere (`rain`, `wind`, `hearth`, `carriage_interior`) to `scene.ambience` so the mixer ducks it cleanly under speech; use discrete `sfx` segments for point-in-time foley (`thunder_crack`, `door_creak`, `footsteps`).
- Music: `theme` at open/close, `sting` after a revelation, `transition` at scene changes.

**Never** invent plot, characters, or dialogue. Never reveal later chapters.

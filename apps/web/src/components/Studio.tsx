"use client";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { castChanges, fileProblem, shouldPoll, stateLabel, unfinishedChapters, voiceChoices, type BookView } from "../studio/logic";

/**
 * The studio (Req 1.1, 2.5, 8.2, 9.1): upload an EPUB you have the right to adapt, choose the
 * chapters and the speech budget, watch the episodes being made, and change a character's voice.
 * Only rendered when generation is enabled; the server refuses every request otherwise.
 */

const PASSKEY_HEADER = "x-midnight-passkey";

async function call<T>(path: string, init: RequestInit, passkey: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (passkey) headers.set(PASSKEY_HEADER, passkey);
  const res = await fetch(path, { ...init, headers, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
  return body as T;
}

export function Studio({ passkeyRequired, initialBookId }: { passkeyRequired: boolean; initialBookId: string | null }) {
  const [passkey, setPasskey] = useState("");
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [book, setBook] = useState<BookView | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [budget, setBudget] = useState(0);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const show = useCallback((b: BookView, resetChoices: boolean) => {
    setBook(b);
    if (resetChoices) {
      setChosen(new Set(unfinishedChapters(b).slice(0, 1)));
      setBudget(b.charBudget);
      setPending({});
    }
    const url = new URL(window.location.href);
    url.searchParams.set("book", b.id);
    window.history.replaceState(null, "", url);
  }, []);

  const refresh = useCallback(
    async (id: string, resetChoices = false) => {
      try {
        show(await call<BookView>(`/api/books/${id}`, {}, passkey), resetChoices);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [passkey, show],
  );

  useEffect(() => {
    if (initialBookId && !book && (!passkeyRequired || passkey)) void refresh(initialBookId, true);
  }, [initialBookId, book, passkeyRequired, passkey, refresh]);

  useEffect(() => {
    if (!shouldPoll(book)) return;
    const t = setTimeout(() => void refresh(book!.id), 3000);
    return () => clearTimeout(t);
  }, [book, refresh]);

  async function upload(file: File) {
    setError(null);
    setNotice(null);
    const problem = fileProblem(file);
    if (problem) return setError(problem);
    if (!rights) return setError("Confirm that you have the right to adapt this book first.");
    setBusy("Reading the book…");
    try {
      const b = await call<BookView>("/api/books", { method: "POST", body: file, headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/epub+zip" } }, passkey);
      show(b, true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function generate(e: FormEvent) {
    e.preventDefault();
    if (!book) return;
    setError(null);
    setNotice(null);
    setBusy("Sending to the studio…");
    try {
      const r = await call<{ queued: string[] }>(`/api/books/${book.id}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chapters: [...chosen], charBudget: budget }) }, passkey);
      setNotice(r.queued.length > 0 ? `${r.queued.length} episode(s) queued. They appear on the radio when ready.` : "Those episodes are already on air.");
      await refresh(book.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveCast() {
    if (!book) return;
    const changes = castChanges(book, pending);
    if (changes.length === 0) return;
    setError(null);
    setNotice(null);
    setBusy("Changing voices…");
    try {
      const r = await call<{ changed: string[]; requeued: string[] }>(`/api/books/${book.id}/cast`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes }) }, passkey);
      setNotice(`New voice for ${r.changed.join(", ")}. ${r.requeued.length} episode(s) will be re-recorded with only those lines changed.`);
      await refresh(book.id, true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void upload(f);
  };

  const voiceName = (id: string | null) => book?.voices.find((v) => v.id === id)?.name ?? id ?? "none";

  return (
    <div className="studio">
      <section className="card" aria-labelledby="rights-h">
        <h2 id="rights-h">Before you upload</h2>
        <p>
          Upload only books you have the right to adapt: works in the public domain where you live, or your own DRM-free writing. The studio turns them into
          AI-generated radio drama; dialogue is kept word for word.
        </p>
        <label className="check">
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> I have the right to adapt the book I upload.
        </label>
        {passkeyRequired && (
          <label className="field">
            Judge passkey
            <input type="password" autoComplete="off" value={passkey} onChange={(e) => setPasskey(e.target.value)} />
          </label>
        )}
      </section>

      <section className="card" aria-labelledby="upload-h">
        <h2 id="upload-h">Upload an EPUB</h2>
        <div
          className={`dropzone${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p>Drop a DRM-free .epub here (up to 20 MB), or</p>
          <button type="button" className="brass-button" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
            Choose a file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".epub,application/epub+zip"
            aria-label="EPUB file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
        </div>
      </section>

      <p role="status" className="studio-status">
        {busy ?? notice ?? ""}
      </p>
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}

      {book && (
        <form className="card" aria-labelledby="book-h" onSubmit={generate} /* the budget field clamps itself; the browser's step check would refuse budgets off the 1,000 grid */ noValidate>
          <h2 id="book-h">The book</h2>
          <p className="book-title">
            {book.title}
            {book.author ? ` · ${book.author}` : ""}
          </p>
          <label className="field">
            Speech budget for this book (characters, at most {book.charCeiling.toLocaleString("en")})
            <input type="number" min={1} max={book.charCeiling} step={1000} value={budget} onChange={(e) => setBudget(Math.max(1, Math.min(book.charCeiling, Number(e.target.value) || 1)))} />
          </label>
          <p className="muted">{book.charsSpent.toLocaleString("en")} characters spoken so far.</p>
          <fieldset className="chapters">
            <legend>Chapters</legend>
            <ol>
              {book.chapters.map((c) => (
                <li key={c.number}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={chosen.has(c.number)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(c.number);
                        else next.delete(c.number);
                        setChosen(next);
                      }}
                    />
                    <span>
                      {c.number}. {c.title} <span className="muted">({c.words.toLocaleString("en")} words)</span>
                    </span>
                  </label>
                  {c.episodes.map((e) => (
                    <p key={e.chapterId} className={`episode-state state-${e.state}`} data-chapter={c.number}>
                      Episode {e.episodeNumber}
                      {c.episodes.length > 1 ? ` (${e.title})` : ""}: {stateLabel(e)}
                      {e.message ? <span className="muted"> · {e.message}</span> : null}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          </fieldset>
          <button type="submit" className="brass-button" disabled={busy !== null || chosen.size === 0}>
            Make {chosen.size === 1 ? "this episode" : `${chosen.size} chapters`}
          </button>
          <p className="muted">
            Finished episodes appear as stations on the <a href="/">radio</a>.
          </p>
        </form>
      )}

      {book?.cast && (
        <section className="card" aria-labelledby="cast-h">
          <h2 id="cast-h">The cast</h2>
          <p className="muted">
            Announcer: {voiceName(book.cast.announcerVoiceId)} · Narrator: {voiceName(book.cast.narratorVoiceId)}. Changing a voice re-records only that character&rsquo;s lines.
          </p>
          <table className="cast-table">
            <thead>
              <tr>
                <th scope="col">Character</th>
                <th scope="col">Voice</th>
              </tr>
            </thead>
            <tbody>
              {book.cast.characters.map((c) => (
                <tr key={c.name}>
                  <th scope="row">
                    {c.name}
                    {c.description ? <span className="muted"> · {c.description}</span> : null}
                  </th>
                  <td>
                    {c.speaks ? (
                      <select aria-label={`Voice for ${c.name}`} value={pending[c.name] ?? c.voiceId ?? ""} onChange={(e) => setPending({ ...pending, [c.name]: e.target.value })}>
                        {voiceChoices(book, c.name, pending).map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name} ({v.gender}, {v.ageBands.join("/")})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">does not speak</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="brass-button" onClick={() => void saveCast()} disabled={busy !== null || castChanges(book, pending).length === 0}>
            Save voice changes
          </button>
        </section>
      )}
    </div>
  );
}

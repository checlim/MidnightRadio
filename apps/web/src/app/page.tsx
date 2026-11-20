import { Radio } from "../components/Radio";
import { generationShown } from "../server/config";

// The studio link depends on GENERATION_ENABLED at run time, not at build time.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="stage">
      <header className="masthead">
        <span className="deco-rule" aria-hidden="true" />
        <h1>
          Midnight <span>Radio</span>
        </h1>
        <p className="tagline">Gothic tales from the public domain, broadcast as they were meant to be heard.</p>
        <span className="deco-rule" aria-hidden="true" />
      </header>
      <Radio />
      {generationShown() && (
        <p className="studio-link">
          <a href="/studio">Make your own broadcast from a DRM-free book</a>
        </p>
      )}
      <footer className="notice">
        <p>
          <strong>AI-generated broadcast.</strong> Every episode is an adaptation of a public-domain book, voiced and mixed by AI.
          Dialogue is taken word for word from the source text; nothing is invented.
        </p>
      </footer>
    </main>
  );
}

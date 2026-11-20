import { notFound } from "next/navigation";
import { Studio } from "../../components/Studio";
import { loadWebConfig } from "../../server/config";
import { loadGuardConfig } from "../../server/guards";

// Read the switch on every request, never at build time.
export const dynamic = "force-dynamic";

/** The studio exists only where generation is enabled (Req 8.5): elsewhere it is a 404, like the API. */
export default async function StudioPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!loadWebConfig().generationEnabled) notFound();
  const book = (await searchParams).book;
  const initialBookId = typeof book === "string" && /^bk-[0-9a-f]{16}$/.test(book) ? book : null;
  return (
    <main className="stage">
      <header className="masthead">
        <span className="deco-rule" aria-hidden="true" />
        <h1>
          The <span>Studio</span>
        </h1>
        <p className="tagline">
          Turn a DRM-free book into a radio drama. <a href="/">Back to the radio</a>
        </p>
        <span className="deco-rule" aria-hidden="true" />
      </header>
      <Studio passkeyRequired={Boolean(loadGuardConfig().passkey)} initialBookId={initialBookId} />
    </main>
  );
}

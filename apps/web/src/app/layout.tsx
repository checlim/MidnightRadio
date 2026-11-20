import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Midnight Radio",
  description: "Public-domain Gothic fiction, performed as golden-age radio drama. Every episode is AI-generated.",
};

export const viewport: Viewport = { themeColor: "#0d1b1e", colorScheme: "dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Every page carries the label (Req 9.3); the episodes carry it in their ID3 tags too. */}
        <p className="ai-badge" role="note">
          AI-generated
        </p>
        {children}
      </body>
    </html>
  );
}

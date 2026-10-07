import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Icon Sheet Studio — Professional Icon-Sheet Artwork",
  description:
    "Turn collections of 100–5,000+ SVG icons into professional icon-sheet artwork. Sheets, hero icons, typography, templates, AI category suggestions, SVG/PNG export. Local-first.",
  keywords: ["icon sheet", "SVG icons", "icon design", "design tool", "vector artwork", "icon grid"],
  icons: {
    icon: "/logo.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F2EB" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
          <SonnerToaster richColors position="bottom-right" closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}

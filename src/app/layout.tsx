import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

const barlow = Barlow({ variable: "--font-barlow", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const barlowCondensed = Barlow_Condensed({ variable: "--font-barlow-condensed", subsets: ["latin"], weight: ["500", "600", "700"] });

export const metadata: Metadata = {
  title: "Vehicle Care",
  description: "Mantenimiento postventa — prototipo con datos sintéticos de demostración",
};

export const viewport: Viewport = { themeColor: "#0f3a47", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-CO" className={`${barlow.variable} ${barlowCondensed.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}

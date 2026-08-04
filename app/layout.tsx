import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Nail Profit OS",
  description: "Себестоимость, маржа и прибыль в час для nail-мастеров и студий.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}

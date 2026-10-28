import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "DAYFORGE",
  description: "Môi trường phát triển DAYFORGE",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): React.JSX.Element {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}

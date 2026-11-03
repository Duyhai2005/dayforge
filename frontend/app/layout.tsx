import type { Metadata } from "next";
import type { ReactNode } from "react";
import { OfflineBootstrap } from "../components/offline/offline-bootstrap";
import { AccountProvider } from "../components/account/account-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "DAYFORGE",
  description: "Lịch công việc và dấu mốc DAYFORGE",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): React.JSX.Element {
  return (
    <html lang="vi">
      <body><OfflineBootstrap><AccountProvider>{children}</AccountProvider></OfflineBootstrap></body>
    </html>
  );
}

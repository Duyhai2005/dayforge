import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "Tài khoản | DAYFORGE", template: "%s | DAYFORGE" },
  description: "Tài khoản DAYFORGE",
};

export default function AccountLayout({
  children,
}: Readonly<{ children: ReactNode }>): React.JSX.Element {
  return (
    <main id="account-main" className="account-main" aria-labelledby="account-title" tabIndex={-1}>
      <section className="account-panel">
        <p className="account-kicker">DAYFORGE</p>
        {children}
        <Link className="account-return" href="/work">Quay lại lịch công việc</Link>
      </section>
    </main>
  );
}

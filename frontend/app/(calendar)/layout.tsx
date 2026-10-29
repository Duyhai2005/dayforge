import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "Lịch | DAYFORGE", template: "%s | DAYFORGE" },
  description: "Lịch công việc và dấu mốc, tuần từ thứ hai đến chủ nhật, UTC+07:00.",
};

export default function CalendarLayout({
  children,
}: Readonly<{ children: ReactNode }>): React.JSX.Element {
  return (
    <main id="calendar-main" className="calendar-main" tabIndex={-1}>
      <div className="calendar-content">{children}</div>
    </main>
  );
}

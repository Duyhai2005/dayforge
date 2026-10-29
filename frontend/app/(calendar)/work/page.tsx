import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarView } from "../../../components/calendar/calendar-view";

export const metadata: Metadata = { title: "Lịch công việc" };

export default function WorkPage(): React.JSX.Element {
  return <Suspense><CalendarView calendar="work" /></Suspense>;
}

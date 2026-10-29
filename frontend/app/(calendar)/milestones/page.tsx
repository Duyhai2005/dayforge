import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarView } from "../../../components/calendar/calendar-view";

export const metadata: Metadata = { title: "Lịch dấu mốc" };

export default function MilestonesPage(): React.JSX.Element {
  return <Suspense><CalendarView calendar="milestones" /></Suspense>;
}

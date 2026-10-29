import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarViewNavigation } from "../../../components/calendar/view-navigation";

export const metadata: Metadata = { title: "Lịch dấu mốc" };

export default function MilestonesPage(): React.JSX.Element {
  return <><h1>Lịch dấu mốc</h1><Suspense><CalendarViewNavigation calendar="milestones" /></Suspense></>;
}

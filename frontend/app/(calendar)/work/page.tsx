import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarViewNavigation } from "../../../components/calendar/view-navigation";

export const metadata: Metadata = { title: "Lịch công việc" };

export default function WorkPage(): React.JSX.Element {
  return <><h1>Lịch công việc</h1><Suspense><CalendarViewNavigation calendar="work" /></Suspense></>;
}

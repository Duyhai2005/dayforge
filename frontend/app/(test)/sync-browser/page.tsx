import { notFound } from "next/navigation";
import { SyncBrowserHarness } from "../../../components/test/sync-browser-harness";

export const dynamic = "force-dynamic";

export default function SyncBrowserTestPage(): React.JSX.Element {
  if (process.env.NODE_ENV === "production" || process.env.DAYFORGE_SYNC_TEST_HARNESS !== "1") {
    notFound();
  }
  return <SyncBrowserHarness />;
}

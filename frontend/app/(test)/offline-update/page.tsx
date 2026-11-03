import { notFound } from "next/navigation";
import { OfflineUpdateMutationHarness } from "../../../components/test/offline-update-mutation-harness";

export const dynamic = "force-dynamic";

export default function OfflineUpdateTestPage(): React.JSX.Element {
  if (process.env.NODE_ENV !== "production" || process.env.DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS !== "1") {
    notFound();
  }
  return <OfflineUpdateMutationHarness />;
}

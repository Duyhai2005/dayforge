import { expect, test } from "@playwright/test";
import { countPendingOperations, syncStatusLabel } from "../lib/sync/status-view";
import type { CoordinatorStatus } from "../lib/sync/coordinator";
import type { StoredOutboxEnvelope } from "../lib/sync/outbox";

test("pendingSummaryMatchesT03OperationSemantics", () => {
  const entries: Array<Pick<StoredOutboxEnvelope, "state" | "superseded_by">> = [
    { state: "queued", superseded_by: null },
    { state: "sending", superseded_by: null },
    { state: "blocked", superseded_by: null },
    { state: "quarantined", superseded_by: null },
    { state: "queued", superseded_by: "55555555-5555-4555-8555-555555555555" },
    { state: "ack_waiting_pull", superseded_by: null },
  ];

  expect(countPendingOperations(entries)).toBe(4);
});

test("syncStatusWaitsForReceiptAndPullBeforeShowingSynced", () => {
  const acknowledgedButAwaitingPull: CoordinatorStatus = { state: "syncing", pending: 0 };
  const fullyReconciled: CoordinatorStatus = { state: "synced" };

  expect(syncStatusLabel(acknowledgedButAwaitingPull)).not.toBe("Đã đồng bộ");
  expect(syncStatusLabel(fullyReconciled)).toBe("Đã đồng bộ");
});

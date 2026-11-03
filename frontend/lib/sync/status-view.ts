import type { CoordinatorStatus } from "./coordinator";
import type { StoredOutboxEnvelope } from "./outbox";

export type PendingOperationFields = Pick<StoredOutboxEnvelope, "state" | "superseded_by">;

/** Count business operations awaiting an acknowledgement, not retries or subcommands. */
export function countPendingOperations(entries: readonly PendingOperationFields[]): number {
  return entries.filter((entry) => !entry.superseded_by && entry.state !== "ack_waiting_pull").length;
}

function attentionCopy(code: string): string {
  if (code === "time_invalid" || code.startsWith("clock_")) return "Cần xử lý thay đổi giờ thiết bị";
  return "Có thay đổi cần xử lý";
}

/** Convert coordinator state to concise Vietnamese copy without exposing internal errors. */
export function syncStatusLabel(status: CoordinatorStatus): string {
  switch (status.state) {
    case "stopped": return "Đồng bộ đang tạm dừng";
    case "waiting_for_leader": return "Đang chờ tab điều phối đồng bộ";
    case "syncing": return status.pending ? `Đang đồng bộ · ${status.pending} mục đang chờ` : "Đang kiểm tra đồng bộ";
    case "synced": return "Đã đồng bộ";
    case "offline": return status.pending
      ? `Ngoại tuyến · ${status.pending} mục chờ kết nối lại`
      : "Ngoại tuyến · sẽ thử đồng bộ lại khi có kết nối";
    case "auth_paused": return status.pending
      ? `Cần đăng nhập lại · ${status.pending} mục đang chờ`
      : "Cần đăng nhập lại để tiếp tục đồng bộ";
    case "blocked": return `${attentionCopy(status.code)} · ${status.pending} mục đang chờ`;
    case "integrity_error": return "Có lỗi toàn vẹn dữ liệu; hãy xem phần trợ giúp";
    case "error": return "Không thể kiểm tra trạng thái đồng bộ; dữ liệu cục bộ vẫn được giữ";
  }
}

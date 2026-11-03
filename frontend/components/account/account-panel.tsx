"use client";

import { useState } from "react";
import { formatAccountError, useAccount } from "./account-provider";
import { useHydrated } from "../../lib/use-hydrated";

type AccountForm = "login" | "register" | "forgot";

function syncLabel(value: ReturnType<typeof useAccount>["syncStatus"]): string {
  switch (value.state) {
    case "syncing": return value.pending ? `Đang đồng bộ · ${value.pending} mục đang chờ` : "Đang kiểm tra đồng bộ";
    case "offline": return `${value.pending} mục đang chờ kết nối lại`;
    case "auth_paused": return `${value.pending} mục đang chờ đăng nhập`;
    case "blocked": return `${value.pending} mục cần xử lý · ${value.code}`;
    case "integrity_error": return `Lỗi toàn vẹn · ${value.code}`;
    case "error": return value.message;
    case "waiting_for_leader": return "Đang chờ tab điều phối đồng bộ";
    case "stopped": return "Đồng bộ đang tạm dừng";
  }
}

export function AccountPanel(): React.JSX.Element {
  const account = useAccount();
  const hydrated = useHydrated();
  const [form, setForm] = useState<AccountForm>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setFormError(null); account.clearNotice();
    try { await work(); }
    catch (cause) { setFormError(`${formatAccountError(cause)} Dữ liệu local vẫn được giữ.`); }
    finally { setBusy(false); }
  };

  const isUnlocked = account.state === "unlocked";
  const showAuth = !(account.session?.authenticated && isUnlocked);
  const clockRecoveryAvailable = account.syncStatus.state === "blocked" &&
    (account.syncStatus.code === "time_invalid" || account.syncStatus.code.startsWith("clock_"));

  return (
    <>
      <h1 id="account-title">Tài khoản</h1>
      <p className="account-copy">Đăng nhập để đồng bộ. Kho local tiếp tục hoạt động khi mất kết nối.</p>

      {account.owner && (
        <div className="account-status" role="status">
          <strong>{account.owner.email ?? "Dữ liệu local trên thiết bị này"}</strong>
          <p>{isUnlocked ? "Kho local đang mở." : account.state === "locked" ? "Kho local đang khóa; hãy xác thực lại để mở." : "Kho local chưa được mở trên thiết bị này."}</p>
          {account.session?.authenticated && isUnlocked && <p>{syncLabel(account.syncStatus)}</p>}
          {account.session?.authenticated && isUnlocked && clockRecoveryAvailable && <>
            <p>Đồng hồ thiết bị đã được hiệu chỉnh. Bạn có thể lưu lại các thay đổi chưa được máy chủ ghi nhận bằng một nhánh thời gian mới.</p>
            <button type="button" className="account-secondary-button" disabled={busy} onClick={() => void run(account.repairClockIssues)}>
              Lưu lại sau sửa giờ thiết bị
            </button>
          </>}
          {account.session?.authenticated && <button type="button" className="account-secondary-button" disabled={busy} onClick={() => void run(account.logout)}>Đăng xuất và khóa kho local</button>}
        </div>
      )}

      {account.info && <p className="account-status" role="status">{account.info}</p>}
      {(formError || account.error) && <p className="account-error" role="alert">{formError ?? account.error}</p>}

      {showAuth && (
        <>
          <nav className="account-form-nav" aria-label="Luồng tài khoản">
            <button type="button" aria-pressed={form === "login"} onClick={() => { setForm("login"); setFormError(null); }}>Đăng nhập</button>
            <button type="button" aria-pressed={form === "register"} onClick={() => { setForm("register"); setFormError(null); }}>Tạo tài khoản</button>
            <button type="button" aria-pressed={form === "forgot"} onClick={() => { setForm("forgot"); setFormError(null); }}>Quên mật khẩu</button>
          </nav>

          <form className="account-form" onSubmit={(event) => {
            event.preventDefault();
            if (form === "login") void run(() => account.login(email, password, remember));
            else if (form === "register") void run(() => account.register(email));
            else void run(() => account.requestPasswordReset(email));
          }}>
            <label htmlFor="account-email">Email</label>
            <input id="account-email" name="email" type="text" inputMode="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} />
            {form === "login" && <>
              <label htmlFor="account-password">Mật khẩu</label>
              <input id="account-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
              <label className="account-checkbox" htmlFor="remember-me"><input id="remember-me" type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Ghi nhớ phiên trên thiết bị này</label>
            </>}
            <button className="account-submit" type="submit" disabled={!hydrated || busy || account.state === "loading"}>
              {busy ? "Đang xử lý…" : form === "login" ? "Đăng nhập và mở kho local" : form === "register" ? "Gửi liên kết xác minh" : "Gửi hướng dẫn đặt lại"}
            </button>
          </form>

          {form === "register" && <p className="account-copy">Bạn sẽ tạo mật khẩu sau khi mở liên kết xác minh email. Màn hình này không phân biệt email được phép hay chưa.</p>}
          {form === "forgot" && <p className="account-copy">Nếu email thuộc tài khoản đã xác minh, hướng dẫn sẽ được gửi tới hộp thư.</p>}
          {account.state === "offline" && <p className="account-status" role="status">Không kết nối được máy chủ. Đăng nhập và đồng bộ cần mạng; dữ liệu local hiện có vẫn được giữ.</p>}
        </>
      )}
    </>
  );
}

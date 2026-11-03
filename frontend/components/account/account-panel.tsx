"use client";

import { useEffect, useState } from "react";
import { AccountRequestError, formatAccountError, useAccount } from "./account-provider";
import { useHydrated } from "../../lib/use-hydrated";
import { syncStatusLabel } from "../../lib/sync/status-view";

type AccountForm = "login" | "register" | "forgot";

export function AccountPanel(): React.JSX.Element {
  const account = useAccount();
  const hydrated = useHydrated();
  const [form, setForm] = useState<AccountForm>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [emailCooldownUntil, setEmailCooldownUntil] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const emailCooldownSeconds = emailCooldownUntil === null ? 0 : Math.max(0, Math.ceil((emailCooldownUntil - clockNow) / 1000));

  useEffect(() => {
    if (emailCooldownSeconds <= 0) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [emailCooldownSeconds]);

  const startEmailCooldown = (seconds: number) => {
    setClockNow(Date.now());
    setEmailCooldownUntil(Date.now() + seconds * 1000);
  };

  const run = async (work: () => Promise<void | number>) => {
    setBusy(true); setFormError(null); account.clearNotice();
    try {
      const result = await work();
      if (typeof result === "number" && result > 0) startEmailCooldown(result);
    }
    catch (cause) {
      setFormError(`${formatAccountError(cause)} Dữ liệu local vẫn được giữ.`);
      if (cause instanceof AccountRequestError && cause.retryAfterSeconds) startEmailCooldown(cause.retryAfterSeconds);
    }
    finally { setBusy(false); }
  };

  const isUnlocked = account.state === "unlocked";
  const canInteract = hydrated && account.state !== "loading";
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
          {account.session?.authenticated && isUnlocked && <p>{syncStatusLabel(account.syncStatus)}</p>}
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
            <button type="button" disabled={!canInteract} aria-pressed={form === "login"} onClick={() => { setForm("login"); setFormError(null); }}>Đăng nhập</button>
            <button type="button" disabled={!canInteract} aria-pressed={form === "register"} onClick={() => { setForm("register"); setFormError(null); }}>Tạo tài khoản</button>
            <button type="button" disabled={!canInteract} aria-pressed={form === "forgot"} onClick={() => { setForm("forgot"); setFormError(null); }}>Quên mật khẩu</button>
          </nav>

          <form className="account-form" onSubmit={(event) => {
            event.preventDefault();
            if (form === "login") void run(() => account.login(email, password, remember));
            else if (form === "register") void run(() => account.register(email));
            else void run(() => account.requestPasswordReset(email));
          }}>
            <label htmlFor="account-email">Email</label>
            <input id="account-email" name="email" type="text" inputMode="email" autoComplete="email" maxLength={254} required disabled={!canInteract} value={email} onChange={(event) => setEmail(event.target.value)} />
            {form === "login" && <>
              <label htmlFor="account-password">Mật khẩu</label>
              <input id="account-password" name="password" type="password" autoComplete="current-password" required disabled={!canInteract} value={password} onChange={(event) => setPassword(event.target.value)} />
              <label className="account-checkbox" htmlFor="remember-me"><input id="remember-me" type="checkbox" disabled={!canInteract} checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Ghi nhớ phiên trên thiết bị này</label>
            </>}
            <button className="account-submit" type="submit" disabled={!canInteract || busy || (form !== "login" && emailCooldownSeconds > 0)}>
              {busy ? "Đang xử lý…" : form !== "login" && emailCooldownSeconds > 0 ? `Thử lại sau ${emailCooldownSeconds} giây` : form === "login" ? "Đăng nhập và mở kho local" : form === "register" ? "Gửi liên kết xác minh" : "Gửi hướng dẫn đặt lại"}
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

"use client";

import { useEffect, useRef, useState } from "react";
import { formatAccountError, useAccount } from "./account-provider";
import { useHydrated } from "../../lib/use-hydrated";

type EmailCallbackProps = Readonly<{ purpose: "verify-email" | "reset-password" }>;

export function EmailCallback({ purpose }: EmailCallbackProps): React.JSX.Element {
  const account = useAccount();
  const hydrated = useHydrated();
  const tokenRef = useRef<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const scrubFragment = () => {
      if (window.location.hash) {
        tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get("token");
      }
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    };
    window.addEventListener("hashchange", scrubFragment);
    scrubFragment();
    return () => window.removeEventListener("hashchange", scrubFragment);
  }, []);

  const title = purpose === "verify-email" ? "Xác minh email" : "Đặt lại mật khẩu";
  return <>
    <h1 id="account-title">{title}</h1>
    <p className="account-copy">{purpose === "verify-email" ? "Chọn mật khẩu sau khi xác nhận quyền truy cập email." : "Chọn mật khẩu mới cho tài khoản."}</p>
    {message && <p className="account-status" role="status">{message}</p>}
    {error && <p className="account-error" role="alert">{error}</p>}
    {!message && <form className="account-form" onSubmit={(event) => {
      event.preventDefault();
      setError(null);
      if (!tokenRef.current) { setError("Không tìm thấy token trong liên kết. Hãy mở lại liên kết trong email hoặc yêu cầu liên kết mới."); return; }
      const normalized = password.normalize("NFC");
      if (Array.from(normalized).length < 15 || Array.from(normalized).length > 128) { setError("Mật khẩu cần từ 15 đến 128 ký tự Unicode."); return; }
      if (normalized !== confirmation.normalize("NFC")) { setError("Hai mật khẩu chưa khớp."); return; }
      setBusy(true);
      const submit = purpose === "verify-email"
        ? account.confirmEmail(tokenRef.current, normalized)
        : account.resetPassword(tokenRef.current, normalized);
      void submit.then(() => {
        tokenRef.current = null;
        setPassword(""); setConfirmation("");
        setMessage(purpose === "verify-email" ? "Email đã được xác minh. Bạn có thể đăng nhập và mở kho local." : "Mật khẩu đã được cập nhật. Hãy đăng nhập lại để mở kho local.");
      }).catch((cause: unknown) => setError(formatAccountError(cause))).finally(() => setBusy(false));
    }}>
      <label htmlFor="callback-password">{purpose === "verify-email" ? "Tạo mật khẩu" : "Mật khẩu mới"}</label>
      <input id="callback-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
      <label htmlFor="callback-confirmation">Nhập lại mật khẩu</label>
      <input id="callback-confirmation" type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      <p className="account-copy">15–128 ký tự Unicode. Có thể dùng khoảng trắng và trình quản lý mật khẩu.</p>
      <button className="account-submit" type="submit" disabled={!hydrated || busy}>{busy ? "Đang xác nhận…" : purpose === "verify-email" ? "Xác minh và tạo tài khoản" : "Đặt lại mật khẩu"}</button>
    </form>}
  </>;
}

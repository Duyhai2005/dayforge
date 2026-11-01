"use client";

import { useState, type FormEvent } from "react";
import { useAuthSession } from "../../lib/auth/session-provider";
import { authErrorText } from "../../lib/services/auth";

type AccountMode = "login" | "register" | "resend" | "forgot";

const MODE_COPY: Record<AccountMode, { title: string; submit: string }> = {
  login: { title: "Đăng nhập", submit: "Đăng nhập" },
  register: { title: "Thiết lập tài khoản", submit: "Gửi email xác minh" },
  resend: { title: "Gửi lại email xác minh", submit: "Gửi email xác minh" },
  forgot: { title: "Quên mật khẩu", submit: "Gửi hướng dẫn đặt lại" },
};

export function AccountForm(): React.JSX.Element {
  const auth = useAuthSession();
  const [mode, setMode] = useState<AccountMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [formNotice, setFormNotice] = useState("");

  const selectMode = (next: AccountMode) => {
    setMode(next);
    setFormError("");
    setFormNotice("");
    setPassword("");
    auth.clearMessages();
  };

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    setFormNotice("");
    try {
      if (mode === "login") {
        const remember = new FormData(event.currentTarget).get("remember_me") === "on";
        await auth.login(email, password, remember);
      } else {
        await auth.requestEmail(mode === "register" ? "register" : mode === "resend" ? "verification/resend" : "password/forgot", email);
        setFormNotice("Nếu email phù hợp, hệ thống sẽ gửi hướng dẫn.");
      }
    } catch (caught) {
      setFormError(authErrorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-form" aria-labelledby="account-title">
      <h1 id="account-title">Tài khoản</h1>
      <p className="account-copy">Đăng nhập để mở khóa dữ liệu đã mã hóa trên thiết bị này.</p>

      {auth.session?.authenticated && auth.session.owner && (
        <div className="account-session" aria-live="polite">
          <p>Đang đăng nhập với <strong>{auth.session.owner.email}</strong>.</p>
          <p role="status">{auth.notice || (auth.ownerUnlocked ? "Dữ liệu cục bộ đã mở khóa." : "Phiên còn hiệu lực; dữ liệu cục bộ vẫn khóa cho đến khi đăng nhập bằng mật khẩu.")}</p>
        </div>
      )}

      <form className="account-fields" onSubmit={submit}>
        {mode !== "login" && <h2>{MODE_COPY[mode].title}</h2>}
        <label className="account-field" htmlFor="account-email">Email
          <input id="account-email" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />
        </label>
        {mode === "login" && <>
          <label className="account-field" htmlFor="account-password">Mật khẩu
            <span className="account-password-control">
              <input id="account-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} />
              <button type="button" className="account-password-toggle" aria-label={showPassword ? "Ẩn" : "Hiện"} title={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"} onClick={() => setShowPassword(value => !value)}>{showPassword ? "Ẩn" : "Hiện"}</button>
            </span>
          </label>
          <label className="account-remember"><input type="checkbox" name="remember_me" defaultChecked /> Ghi nhớ đăng nhập</label>
        </>}
        {formError && <p className="account-error" role="alert">{formError}</p>}
        {formNotice && <p className="account-status" role="status">{formNotice}</p>}
        {auth.error && !formError && <p className="account-error" role="alert">{auth.error}</p>}
        {auth.notice && mode === "login" && !auth.session?.authenticated && <p className="account-status" role="status">{auth.notice}</p>}
        <button className="account-submit" type="submit" disabled={busy}>
          {busy ? "Đang xử lý…" : MODE_COPY[mode].submit}
        </button>
      </form>

      <nav className="account-actions" aria-label="Tùy chọn tài khoản">
        {mode !== "login" && <button type="button" onClick={() => selectMode("login")}>Quay lại đăng nhập</button>}
        <button type="button" aria-pressed={mode === "register"} onClick={() => selectMode("register")}>Thiết lập ban đầu</button>
        <button type="button" aria-pressed={mode === "resend"} onClick={() => selectMode("resend")}>Gửi lại xác minh</button>
        <button type="button" aria-pressed={mode === "forgot"} onClick={() => selectMode("forgot")}>Quên mật khẩu</button>
      </nav>
      <p className="account-copy">Yêu cầu email luôn trả lời trung tính; chỉ địa chỉ đủ điều kiện mới nhận được hướng dẫn.</p>
    </section>
  );
}

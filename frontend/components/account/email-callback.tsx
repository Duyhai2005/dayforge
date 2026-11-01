"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { authErrorText, postAuth } from "../../lib/services/auth";

type EmailCallbackProps = Readonly<{ purpose: "verify-email" | "reset-password" }>;
type CallbackState = "waiting" | "submitting" | "success";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NEUTRAL_COPY = "Chức năng tài khoản chưa được kết nối.";

export function EmailCallback({ purpose }: EmailCallbackProps): React.JSX.Element {
  const router = useRouter();
  const tokenRef = useRef<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [state, setState] = useState<CallbackState>("waiting");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const captureAndScrub = (clearWhenMissing = false) => {
      const fragment = window.location.hash.slice(1);
      if (fragment) {
        const candidate = new URLSearchParams(fragment).get("token");
        tokenRef.current = candidate && TOKEN_PATTERN.test(candidate) ? candidate : null;
      } else if (clearWhenMissing) {
        tokenRef.current = null;
      }
      setHasToken(tokenRef.current !== null);
      setError("");
      if (window.location.hash) {
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      }
    };
    const onHashChange = () => captureAndScrub(true);
    window.addEventListener("hashchange", onHashChange);
    captureAndScrub();
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    if (purpose === "reset-password" && password !== confirmation) {
      setError("Hai mật khẩu không khớp. Hãy nhập lại.");
      return;
    }
    const token = tokenRef.current;
    if (!token) {
      setError("Liên kết không hợp lệ hoặc không còn dùng được.");
      return;
    }
    setState("submitting");
    try {
      if (purpose === "verify-email") {
        await postAuth("verification/confirm", { token, password });
        setNotice("Email đã xác minh. Đang chuyển tới đăng nhập…");
      } else {
        await postAuth("password/reset", { token, password });
        setNotice("Mật khẩu đã được đặt lại. Đang chuyển tới đăng nhập…");
      }
      tokenRef.current = null;
      setHasToken(false);
      setPassword("");
      setConfirmation("");
      setState("success");
      window.setTimeout(() => router.replace("/account"), 1000);
    } catch (caught) {
      setState("waiting");
      setError(authErrorText(caught));
    }
  }

  const isReset = purpose === "reset-password";
  const title = isReset ? "Đặt lại mật khẩu" : "Xác minh email";

  return (
    <>
      <h1 id="account-title">{title}</h1>
      {!hasToken && <p className="account-copy">Liên kết này chưa sẵn sàng để xử lý.</p>}
      {hasToken && state !== "success" && <form className="account-fields" onSubmit={submit}>
        {isReset && <p className="account-copy">Chọn mật khẩu mới cho tài khoản của bạn.</p>}
        <label className="account-field" htmlFor="callback-password">{isReset ? "Mật khẩu mới" : "Mật khẩu"}
          <input id="callback-password" type="password" autoComplete="new-password" required minLength={15} maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} />
        </label>
        {isReset && <label className="account-field" htmlFor="callback-confirmation">Nhập lại mật khẩu mới
          <input id="callback-confirmation" type="password" autoComplete="new-password" required minLength={15} maxLength={1024} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
        </label>}
        {error && <p className="account-error" role="alert">{error}</p>}
        <button className="account-submit" type="submit" disabled={state === "submitting"}>
          {state === "submitting" ? "Đang xử lý…" : isReset ? "Đặt lại mật khẩu" : "Xác nhận email"}
        </button>
      </form>}
      {notice && <p className="account-status" role="status">{notice}</p>}
      {!hasToken && !notice && <p className="account-status" role="status">{NEUTRAL_COPY}</p>}
      {hasToken && !notice && <p className="account-copy">Liên kết sẽ chỉ được xác nhận sau khi bạn gửi biểu mẫu.</p>}
      <Link className="account-return" href="/account">Đăng nhập</Link>
    </>
  );
}

"use client";

import { useEffect, useRef } from "react";

type EmailCallbackProps = Readonly<{ purpose: "verify-email" | "reset-password" }>;

export function EmailCallback({ purpose }: EmailCallbackProps): React.JSX.Element {
  const tokenRef = useRef<string | null>(null);
  const fragmentReadRef = useRef(false);

  useEffect(() => {
    if (!fragmentReadRef.current) {
      tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get("token");
      fragmentReadRef.current = true;
    }
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, []);

  return (
    <>
      <h1 id="account-title">{purpose === "verify-email" ? "Xác minh email" : "Đặt lại mật khẩu"}</h1>
      <p className="account-copy">Liên kết này chưa được xử lý.</p>
      <p className="account-status" role="status">Chức năng tài khoản chưa được kết nối.</p>
    </>
  );
}

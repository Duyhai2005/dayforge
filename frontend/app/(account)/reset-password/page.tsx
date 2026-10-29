import type { Metadata } from "next";
import { EmailCallback } from "../../../components/account/email-callback";

export const metadata: Metadata = { title: "Đặt lại mật khẩu" };
export const dynamic = "force-dynamic";

export default function ResetPasswordPage(): React.JSX.Element {
  return <EmailCallback purpose="reset-password" />;
}

import type { Metadata } from "next";
import { EmailCallback } from "../../../components/account/email-callback";

export const metadata: Metadata = { title: "Xác minh email" };
export const dynamic = "force-dynamic";

export default function VerifyEmailPage(): React.JSX.Element {
  return <EmailCallback purpose="verify-email" />;
}

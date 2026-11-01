import type { Metadata } from "next";
import { AccountForm } from "../../../components/account/account-form";
import { AuthSessionProvider } from "../../../lib/auth/session-provider";

export const metadata: Metadata = { title: "Tài khoản" };

export default function AccountPage(): React.JSX.Element {
  return (
    <AuthSessionProvider>
      <AccountForm />
    </AuthSessionProvider>
  );
}

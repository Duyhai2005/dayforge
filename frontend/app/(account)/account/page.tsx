import type { Metadata } from "next";
import { AccountPanel } from "../../../components/account/account-panel";

export const metadata: Metadata = { title: "Tài khoản" };

export default function AccountPage(): React.JSX.Element {
  return <AccountPanel />;
}

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Tài khoản" };

export default function AccountPage(): React.JSX.Element {
  return (
    <>
      <h1 id="account-title">Tài khoản</h1>
      <p className="account-copy">Bạn có thể quay lại lịch để tiếp tục xem.</p>
      <p className="account-status" role="status">Chức năng tài khoản chưa được kết nối.</p>
    </>
  );
}

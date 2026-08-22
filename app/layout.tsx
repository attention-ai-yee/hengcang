import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "衡仓 · 个人投资操作系统",
  description: "本地优先的资产配置、估值监控与风险控制 Dashboard",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

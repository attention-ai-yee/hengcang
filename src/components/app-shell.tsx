import Link from "next/link";
import {
  BookOpen,
  ChartNoAxesCombined,
  Database,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  Scale,
  Settings,
  WalletCards,
} from "lucide-react";

const navigation = [
  { href: "/dashboard", label: "总览", icon: LayoutDashboard },
  { href: "/scores", label: "资产评分", icon: Gauge },
  { href: "/holdings", label: "持仓与风险", icon: WalletCards },
  { href: "/rebalance", label: "再平衡", icon: Scale },
  { href: "/decisions", label: "决策日志", icon: BookOpen },
  { href: "/backtest", label: "策略回测", icon: FlaskConical },
  { href: "/data-status", label: "数据状态", icon: Database },
  { href: "/settings", label: "设置", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const automaticDataConfigured = Boolean(process.env.TUSHARE_TOKEN);
  return (
    <div className="product-shell grid min-h-screen grid-cols-[240px_1fr]">
      <aside className="sidebar sticky top-0 flex h-screen flex-col bg-[#112d25] p-5 text-white">
        <Link href="/dashboard" className="mb-8 flex items-center gap-3 px-2 py-2">
          <span className="grid size-10 place-items-center rounded-xl bg-[#d9aa57] text-[#173f32]">
            <ChartNoAxesCombined size={21} strokeWidth={2.4} />
          </span>
          <span>
            <strong className="block text-lg tracking-wide">衡仓</strong>
            <small className="text-xs text-[#a9c3b7]">Investment OS</small>
          </span>
        </Link>

        <nav className="sidebar-nav grid gap-1" aria-label="主导航">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[#d8e5df] transition hover:bg-white/10 hover:text-white"
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>

        <div className="mt-auto rounded-2xl border border-white/10 bg-white/5 p-4 text-xs leading-5 text-[#b8cbc2]">
          <strong className="mb-1 block text-white">本地单用户模式</strong>
          数据保存在本机 SQLite。系统不连接券商，也不执行交易。
        </div>
      </aside>

      <main className="min-w-0">
        <header className="flex items-center justify-between border-b border-[#dce3de] bg-white/70 px-6 py-4 backdrop-blur md:px-10">
          <p className="text-sm text-[#627169]">资产配置 · 估值监控 · 风险纪律</p>
          <div className="rounded-full border border-[#cddbd3] bg-[#edf5f0] px-3 py-1.5 text-xs font-semibold text-[#285443]">
            {automaticDataConfigured ? "Tushare 自动数据已配置" : "手工数据兜底可用"}
          </div>
        </header>
        <div className="mx-auto max-w-[1480px] p-5 md:p-8 lg:p-10">{children}</div>
      </main>
    </div>
  );
}

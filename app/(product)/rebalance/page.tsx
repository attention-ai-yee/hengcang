import { redirect } from "next/navigation";

/** 再平衡已并入「持仓与风险」页；保留路径重定向兼容旧链接。 */
export default function RebalancePage() {
  redirect("/holdings");
}

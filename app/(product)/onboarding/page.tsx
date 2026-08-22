import { HoldingForm } from "@/components/holding-form";
import { PageIntro } from "@/components/ui";

export default function OnboardingPage() {
  return (
    <>
      <PageIntro eyebrow="Onboarding" title="建立你的资产基线" description="先确认真实持仓，再做集中度和评分判断。约数与账户汇总会被明确标记。" />
      <HoldingForm />
    </>
  );
}

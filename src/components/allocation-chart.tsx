"use client";

import * as echarts from "echarts";
import { useEffect, useRef } from "react";

export interface AllocationDatum {
  name: string;
  value: number;
}

export function AllocationChart({ data }: { data: AllocationDatum[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption({
      color: ["#244b3e", "#d4a34f", "#66886f", "#5c7289", "#b9beb9"],
      tooltip: { trigger: "item", valueFormatter: (value: number) => `${value.toFixed(1)}%` },
      series: [
        {
          type: "pie",
          radius: ["61%", "82%"],
          center: ["50%", "50%"],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 6 },
          label: { show: false },
          emphasis: { scaleSize: 4 },
          data,
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [data]);

  return <div ref={ref} className="h-64 w-full" role="img" aria-label="当前资产桶占比环形图" />;
}

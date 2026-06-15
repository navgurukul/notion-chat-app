export type ComputeSizing = {
  instance: {
    /** EC2 on-demand hourly estimate */
    hourlyUsd: number;
  };
};

export type RdsSizing = {
  /** Placeholder monthly estimate for RDS */
  monthlyUsd: number;
};

// NOTE: Replace these values with your region + pricing details.
export const DEFAULT_COMPUTE_SIZING: ComputeSizing = {
  instance: {
    // Placeholder for t3.small
    hourlyUsd: 0.0,
  },
};

export const DEFAULT_RDS_SIZING: RdsSizing = {
  // Placeholder for your chosen RDS instance/class/storage
  monthlyUsd: 0.0,
};

export function estimateEc2Monthly({
  hourlyUsd,
}: {
  hourlyUsd: number;
}) {
  const hoursPerMonth = 24 * 30;
  const monthlyUsd = hourlyUsd * hoursPerMonth;
  return { monthlyUsd };
}

export function estimateRdsMonthly({ monthlyUsd }: { monthlyUsd: number }) {
  return { monthlyUsd };
}

export function formatMoney(n: number) {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}



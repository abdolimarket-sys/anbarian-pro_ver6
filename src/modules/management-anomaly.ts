/** Read-only month-over-month management alerts. */
export type ManagementMonthRow = {
  month: string;
  salesRial?: number;
  grossProfitRial?: number;
  expensesRial?: number;
  receiptsRial?: number;
  paymentsRial?: number;
  receivableRial?: number;
};

export type ManagementAnomaly = {
  month: string;
  previousMonth: string;
  key: string;
  label: string;
  previousValue: number;
  currentValue: number;
  delta: number;
  percentChange: number;
  severity: 'warning' | 'positive';
  message: string;
};

const METRICS = [
  { key: 'salesRial', label: 'فروش قطعی', adverse: 'down' },
  { key: 'grossProfitRial', label: 'سود ناخالص', adverse: 'down' },
  { key: 'expensesRial', label: 'هزینه گروه ۶', adverse: 'up' },
  { key: 'receiptsRial', label: 'دریافت قطعی', adverse: 'down' },
  { key: 'paymentsRial', label: 'پرداخت قطعی', adverse: 'up' },
  { key: 'receivableRial', label: 'مطالبات باز', adverse: 'up' },
] as const;

/** Compare adjacent available months; zero baselines are intentionally skipped. */
export function detectManagementMonthAnomalies(
  rows: ManagementMonthRow[], thresholdPercent = 20,
): ManagementAnomaly[] {
  const threshold = Number(thresholdPercent);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 500) {
    throw new Error('آستانه هشدار باید بین ۱ تا ۵۰۰ درصد باشد.');
  }
  const ordered = [...rows].sort((a, b) => a.month.localeCompare(b.month));
  const alerts: ManagementAnomaly[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    for (const metric of METRICS) {
      const before = Number(previous[metric.key] ?? 0);
      const after = Number(current[metric.key] ?? 0);
      if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) continue;
      const delta = after - before;
      const percentChange = delta / Math.abs(before) * 100;
      if (Math.abs(percentChange) < threshold) continue;
      const unfavorable = metric.adverse === 'down' ? delta < 0 : delta > 0;
      alerts.push({
        month: current.month, previousMonth: previous.month, key: metric.key,
        label: metric.label, previousValue: before, currentValue: after, delta,
        percentChange, severity: unfavorable ? 'warning' : 'positive',
        message: `${metric.label} در ${current.month} نسبت به ${previous.month} ${delta > 0 ? 'افزایش' : 'کاهش'} ${Math.abs(percentChange).toFixed(1)}٪ داشته است.`,
      });
    }
  }
  return alerts.sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange));
}

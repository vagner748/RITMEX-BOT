export function formatNumber(value: number | null | undefined, digits = 4, fallback = "-"): string {
  if (value == null || Number.isNaN(value)) return fallback;
  return Number(value).toFixed(digits);
}

export function formatTrendLabel(trend: "Comprar" | "Vender" | "Sem sinal"): string {
  return trend;
}

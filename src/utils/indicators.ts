
/**
 * Calculates the Relative Strength Index (RSI) for a given set of prices.
 * @param prices An array of numbers representing the prices.
 * @param period The period to use for RSI calculation, typically 14.
 * @returns The latest RSI value, or NaN if not enough data.
 */
export function calculateRSI(prices: number[], period = 14): number {
  if (prices.length <= period) {
    return NaN; // Not enough data to calculate RSI
  }

  let gains = 0;
  let losses = 0;

  // Calculate initial average gains and losses
  for (let i = 1; i <= period; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference >= 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smooth the average gains and losses for the rest of the prices
  for (let i = period + 1; i < prices.length; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference >= 0) {
      avgGain = (avgGain * (period - 1) + difference) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - difference) / period;
    }
  }

  if (avgLoss === 0) {
    return 100; // RSI is 100 if average loss is zero
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
}

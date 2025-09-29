import type { OrderSide } from "../core/types";

export interface GridLevel {
  price: number;
  side: OrderSide;
}

/**
 * Calculates the price levels for a trading grid.
 * @param centerPrice The center price of the grid.
 * @param numLevels The total number of orders in the grid (must be an even number).
 * @param spacingPct The percentage spacing between each grid level.
 * @returns An array of GridLevel objects representing the buy and sell levels.
 */
export function calculateGridLevels(centerPrice: number, numLevels: number, spacingPct: number): GridLevel[] {
  if (numLevels % 2 !== 0) {
    throw new Error("Grid creation failed: Number of levels must be even.");
  }

  const levels: GridLevel[] = [];
  const halfLevels = numLevels / 2;
  const spacing = centerPrice * (spacingPct / 100);

  // Sell levels (above center price)
  for (let i = 1; i <= halfLevels; i++) {
    const price = centerPrice + i * spacing;
    levels.push({ price, side: "sell" });
  }

  // Buy levels (below center price)
  for (let i = 1; i <= halfLevels; i++) {
    const price = centerPrice - i * spacing;
    levels.push({ price, side: "buy" });
  }

  return levels;
}

/**
 * Calculates the profit target price for a given entry.
 * @param entryPrice The price at which the position was entered.
 * @param side The side of the entry trade ('buy' or 'sell').
 * @param profitPct The desired profit percentage.
 * @returns The calculated target price.
 */
export function calculateProfitTarget(entryPrice: number, side: OrderSide, profitPct: number): number {
  const profitMultiplier = profitPct / 100;

  if (side === "buy") {
    return entryPrice * (1 + profitMultiplier);
  } else {
    // For a 'sell' entry, the profit target is lower.
    return entryPrice * (1 - profitMultiplier);
  }
}

import { gridConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type { AsterOrder, OrderSide } from "../exchanges/types";
import { calculateGridLevels, GridLevel } from "../utils/grid-helpers";
import { getOrdersByStrategy, Strategy } from "../core/order-coordinator";

export interface OpenPosition {
  order: AsterOrder;
  stopLossPrice: number;
  takeProfitPrice: number;
  pnl?: number;
}

export interface GridManagerSnapshot {
  centerPrice: number;
  gridLevels: GridLevel[];
  openPositions: OpenPosition[];
  activeGridOrders: AsterOrder[];
}

/**
 * Manages the state and logic of the grid trading strategy.
 */
export class GridManager {
  private readonly adapter: ExchangeAdapter;
  private readonly strategy: Strategy = "grid";

  // State
  public centerPrice: number = 0;
  public gridLevels: GridLevel[] = [];
  public openPositions: OpenPosition[] = [];
  public activeGridOrders: AsterOrder[] = [];

  constructor(adapter: ExchangeAdapter) {
    this.adapter = adapter;
  }

  getSnapshot(): GridManagerSnapshot {
    return {
      centerPrice: this.centerPrice,
      gridLevels: [...this.gridLevels],
      openPositions: [...this.openPositions],
      activeGridOrders: [...this.activeGridOrders],
    };
  }

  /**
   * CRITICAL: Initializes the manager by fetching current market state.
   */
  async initialize(currentPrice: number): Promise<void> {
    const allOpenOrders = await this.adapter.getOpenOrders(gridConfig.symbol);
    this.activeGridOrders = getOrdersByStrategy(allOpenOrders, this.strategy);

    // TODO: Recover open positions and map them to grid trades

    if (this.openPositions.length === 0) {
      await this.recenterGrid(currentPrice);
    }
  }

  updateActiveOrders(orders: AsterOrder[]): void {
    this.activeGridOrders = orders;
  }

  /**
   * Recalculates the center price and the entire grid based on it.
   */
  async recenterGrid(currentPrice: number): Promise<void> {
    // In a real implementation, this would fetch last X candles to calculate the average
    this.centerPrice = currentPrice;
    this.gridLevels = calculateGridLevels(this.centerPrice, gridConfig.numOrders, gridConfig.spacingPct);
  }

  /**
   * Generates a unique, namespaced clientOrderId.
   */
  generateOrderId(side: OrderSide, level: number): string {
    return `${this.strategy}_${side}_${level}_${Date.now()}`;
  }

  /**
   * Determines if the grid should be rebalanced based on price deviation.
   */
  shouldRebalance(currentPrice: number): boolean {
    if (this.centerPrice === 0) return true; // Rebalance if not yet centered
    const deviation = Math.abs(currentPrice - this.centerPrice) / this.centerPrice;
    return deviation > 0.02; // 2% deviation threshold
  }

  /**
   * The core logic to determine which grid orders should be active.
   */
  getDesiredOrders(currentPrice: number, rsi: number): Omit<AsterOrder, 'orderId' | 'status'>[] {
    const desiredOrders: Omit<AsterOrder, 'orderId' | 'status'>[] = [];

    if (this.gridLevels.length === 0) return [];

    // Condition to avoid operating in low spread
    const buyLevels = this.gridLevels.filter(l => l.side === 'buy').sort((a,b) => b.price - a.price);
    const sellLevels = this.gridLevels.filter(l => l.side === 'sell').sort((a,b) => a.price - b.price);
    
    if (!buyLevels.length || !sellLevels.length) return [];

    const spread = sellLevels[0].price - buyLevels[0].price;
    const spreadPct = (spread / currentPrice) * 100;
    if (spreadPct < gridConfig.minSpreadPct) {
      return [];
    }

    const canPlaceBuy = rsi < 50;
    const canPlaceSell = rsi > 50;

    if (canPlaceBuy) {
      for (const level of buyLevels) {
        desiredOrders.push(this.createOrderObjectForLevel(level));
      }
    }

    if (canPlaceSell) {
      for (const level of sellLevels) {
        // Here we would also check if we have a position to sell
        desiredOrders.push(this.createOrderObjectForLevel(level));
      }
    }

    return desiredOrders;
  }

  private createOrderObjectForLevel(level: GridLevel): Omit<AsterOrder, 'orderId' | 'status'> {
    return {
      clientOrderId: this.generateOrderId(level.side, this.gridLevels.indexOf(level)),
      symbol: gridConfig.symbol,
      side: level.side,
      type: 'LIMIT',
      price: String(level.price),
      origQty: String(gridConfig.orderSize),
      executedQty: '0',
      stopPrice: '0',
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: false,
      closePosition: false,
    };
  }
}

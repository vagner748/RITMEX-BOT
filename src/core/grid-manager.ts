import { gridConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type { AsterKline, AsterOrder, OrderSide } from "../exchanges/types";
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

export class GridManager {
  private readonly adapter: ExchangeAdapter;
  private readonly strategy: Strategy = "grid";

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

  async initialize(currentPrice: number, klines: AsterKline[]): Promise<void> {
    const allOpenOrders = await this.adapter.getOpenOrders(gridConfig.symbol);
    this.activeGridOrders = getOrdersByStrategy(allOpenOrders, this.strategy);

    const positions = await this.adapter.getPositions(gridConfig.symbol);
    for (const pos of positions) {
      if (Math.abs(parseFloat(pos.positionAmt)) > 0) {
        const entryPrice = parseFloat(pos.entryPrice);
        // This is a simplified recovery. A robust implementation would need
        // to map the position back to the exact grid order that created it.
        this.openPositions.push({
          order: { side: parseFloat(pos.positionAmt) > 0 ? 'BUY' : 'SELL', price: pos.entryPrice, origQty: pos.positionAmt } as AsterOrder,
          stopLossPrice: this.calculateStopLoss(entryPrice, pos.positionAmt),
          takeProfitPrice: this.calculateTakeProfit(entryPrice, pos.positionAmt),
          pnl: parseFloat(pos.unrealizedProfit)
        });
      }
    }

    if (this.openPositions.length === 0) {
      await this.recenterGrid(klines);
    }
  }

  updateActiveOrders(orders: AsterOrder[]): void {
    this.activeGridOrders = orders;
  }

  async recenterGrid(klines: AsterKline[]): Promise<void> {
    if (klines.length < gridConfig.centerCandles) {
        // Not enough data to calculate center price, use last price as fallback
        this.centerPrice = klines.length > 0 ? parseFloat(klines[klines.length - 1].close) : this.centerPrice;
    } else {
        const recentCandles = klines.slice(-gridConfig.centerCandles);
        const sum = recentCandles.reduce((acc, k) => acc + parseFloat(k.close), 0);
        this.centerPrice = sum / recentCandles.length;
    }
    
    this.gridLevels = calculateGridLevels(
      this.centerPrice, 
      gridConfig.numOrders, 
      gridConfig.spacingPct
    );
  }

  generateOrderId(side: OrderSide, level: number): string {
    return `${this.strategy}_${side}_${level}_${Date.now()}`;
  }

  shouldRebalance(currentPrice: number): boolean {
    if (this.centerPrice === 0) return true;
    const deviation = Math.abs(currentPrice - this.centerPrice) / this.centerPrice;
    return deviation > 0.02; // 2% deviation threshold
  }

  getDesiredOrders(currentPrice: number, rsi: number): Omit<AsterOrder, 'orderId' | 'status'>[] {
    if (this.openPositions.length >= gridConfig.maxPositions) {
      return []; // Do not create new orders if position limit is reached
    }

    const desiredOrders: Omit<AsterOrder, 'orderId' | 'status'>[] = [];
    if (this.gridLevels.length === 0) return [];

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
        const hasLongPosition = this.openPositions.some(p => p.order.side === 'BUY');
        if (hasLongPosition) {
          desiredOrders.push(this.createOrderObjectForLevel(level));
        }
      }
    }

    return desiredOrders;
  }

  async managePositions(
    currentPrice: number,
    log: (type: string, detail: string) => void
  ): Promise<void> {
    for (let i = this.openPositions.length - 1; i >= 0; i--) {
      const pos = this.openPositions[i];
      const isLong = pos.order.side === 'BUY';

      if ((isLong && currentPrice <= pos.stopLossPrice) || (!isLong && currentPrice >= pos.stopLossPrice)) {
        log('stop', `Stop loss triggered for position ${pos.order.clientOrderId} @ ${currentPrice}`);
        await this.closePosition(pos, log);
        this.openPositions.splice(i, 1);
        continue;
      }

      if ((isLong && currentPrice >= pos.takeProfitPrice) || (!isLong && currentPrice <= pos.takeProfitPrice)) {
        log('profit', `Take profit triggered for position ${pos.order.clientOrderId} @ ${currentPrice}`);
        await this.closePosition(pos, log);
        this.openPositions.splice(i, 1);
        continue;
      }

      const entryPrice = parseFloat(pos.order.price);
      const qty = parseFloat(pos.order.origQty);
      pos.pnl = isLong 
        ? (currentPrice - entryPrice) * qty
        : (entryPrice - currentPrice) * qty;
    }
  }

  private async closePosition(
    pos: OpenPosition,
    log: (type: string, detail: string) => void
  ): Promise<void> {
    const closeSide = pos.order.side === 'BUY' ? 'SELL' : 'BUY';
    const qty = parseFloat(pos.order.origQty);
    
    log('close', `Closing position ${pos.order.clientOrderId} with market order.`);
    await this.adapter.createOrder({
      symbol: gridConfig.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: 'true'
    });
  }

  private calculateStopLoss(entryPrice: number, positionAmt: string): number {
    const isLong = parseFloat(positionAmt) > 0;
    return isLong 
      ? entryPrice * (1 - gridConfig.stopLossPct / 100)
      : entryPrice * (1 + gridConfig.stopLossPct / 100);
  }

  private calculateTakeProfit(entryPrice: number, positionAmt: string): number {
    const isLong = parseFloat(positionAmt) > 0;
    return isLong 
      ? entryPrice * (1 + gridConfig.profitPct / 100)
      : entryPrice * (1 - gridConfig.profitPct / 100);
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

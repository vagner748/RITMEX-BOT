import { EventEmitter } from "events";
import { gridConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import { GridManager, type GridManagerSnapshot } from "./grid-manager";
import { cancelOrdersByStrategy, getOrdersByStrategy, placeOrder, Strategy } from "./order-coordinator";
import { calculateRSI } from "../utils/indicators";
import type { AsterKline } from "../exchanges/types";

export interface GridEngineSnapshot extends GridManagerSnapshot {
  symbol: string;
  ready: boolean;
  lastPrice: number;
  rsi: number;
  tradeLog: { time: string; type: string; detail: string }[];
}

/**
 * The main engine for the Grid Trading strategy.
 * Manages the strategy lifecycle and emits state snapshots for the UI.
 */
export class GridEngine extends EventEmitter {
  private readonly adapter: ExchangeAdapter;
  private readonly gridManager: GridManager;
  private readonly strategy: Strategy = "grid";
  private readonly tradeLog: { time: string; type: string; detail: string }[] = [];
  private tickTimer: NodeJS.Timeout | null = null;

  // State
  private klines: AsterKline[] = [];
  private lastPrice: number = 0;
  private rsi: number = 50;
  private ready: boolean = false;

  constructor(adapter: ExchangeAdapter) {
    super();
    this.adapter = adapter;
    this.gridManager = new GridManager(adapter);
  }

  public getSnapshot(): GridEngineSnapshot {
    return {
      ...this.gridManager.getSnapshot(),
      symbol: gridConfig.symbol,
      ready: this.ready,
      lastPrice: this.lastPrice,
      rsi: this.rsi,
      tradeLog: this.tradeLog,
    };
  }

  public async start(): Promise<void> {
    this.log("info", "Initializing Grid Trading strategy...");

    if (!gridConfig.enabled) {
      this.log("info", "Grid Trading is disabled in the configuration.");
      return;
    }

    await this.gridManager.initialize(this.lastPrice);

    this.adapter.watchKlines(gridConfig.symbol, gridConfig.rsiTimeframe, (newKlines) => {
      this.klines = newKlines;
      const prices = this.klines.map(k => parseFloat(k.close));
      this.rsi = calculateRSI(prices, gridConfig.rsiPeriod);
    });

    this.adapter.watchTicker(gridConfig.symbol, (ticker) => {
      this.lastPrice = parseFloat(ticker.lastPrice);
      if (!this.ready) this.ready = true;
    });

    this.tickTimer = setInterval(() => this.runTick(), 5000); // Run every 5 seconds
    this.log("info", "Grid Trading strategy is now running.");
  }

  public stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.log("info", "Grid Trading strategy stopped.");
  }

  private log(type: string, detail: string): void {
    this.tradeLog.push({ time: new Date().toLocaleTimeString(), type, detail });
    if (this.tradeLog.length > 50) {
      this.tradeLog.shift();
    }
  }

  private async runTick(): Promise<void> {
    try {
      if (!this.ready) return;

      // 1. Check for rebalancing
      if (this.gridManager.shouldRebalance(this.lastPrice)) {
        this.log("grid", `Price moved significantly. Rebalancing grid around ${this.lastPrice}...`);
        const openOrders = await this.adapter.getOpenOrders(gridConfig.symbol);
        await cancelOrdersByStrategy(this.adapter, gridConfig.symbol, openOrders, this.strategy, (t, d) => this.log(t, d));
        await this.gridManager.recenterGrid(this.lastPrice);
      }

      // 2. Get desired orders and current active orders
      const desiredOrders = this.gridManager.getDesiredOrders(this.lastPrice, this.rsi);
      const openOrders = await this.adapter.getOpenOrders(gridConfig.symbol);
      const activeGridOrders = getOrdersByStrategy(openOrders, this.strategy);
      this.gridManager.updateActiveOrders(activeGridOrders);

      // 3. Synchronize orders
      await this.syncOrders(desiredOrders, activeGridOrders);

      // 4. Manage open positions (stop loss, take profit)
      // await this.gridManager.managePositions();

    } catch (error) {
      this.log("error", error instanceof Error ? error.message : String(error));
    }

    // Emit snapshot for UI
    this.emit("update", this.getSnapshot());
  }

  private async syncOrders(desiredOrders: Omit<AsterOrder, 'orderId' | 'status'>[], activeOrders: AsterOrder[]): Promise<void> {
    // Orders to place
    for (const desired of desiredOrders) {
      const exists = activeOrders.some(active => active.price === desired.price && active.side === desired.side);
      if (!exists) {
        this.log("order", `Placing new grid order: ${desired.side} @ ${desired.price}`);
        await placeOrder(
          this.adapter,
          gridConfig.symbol,
          activeOrders, // pass full list for deduplication context
          {},
          {},
          {},
          this.strategy,
          desired.side,
          parseFloat(desired.price),
          gridConfig.orderSize,
          (t, d) => this.log(t, d),
          desired.clientOrderId
        );
      }
    }

    // Orders to cancel
    for (const active of activeOrders) {
      const stillDesired = desiredOrders.some(desired => desired.price === active.price && desired.side === active.side);
      if (!stillDesired) {
        this.log("order", `Cancelling stale grid order: ${active.side} @ ${active.price}`);
        await this.adapter.cancelOrder({ symbol: gridConfig.symbol, orderId: active.orderId });
      }
    }
  }
}

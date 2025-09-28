import type { TradingConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterOrder,
  AsterTicker,
  AsterDepth,
  AsterKline,
} from "../exchanges/types";
import {
  getPosition,
  getSMA,
  getRSI,
  type PositionSnapshot,
} from "../utils/strategy";
import { computePositionPnl } from "../utils/pnl";
import { getMidOrLast } from "../utils/price";
import {
  marketClose,
  placeMarketOrder,
  placeStopLossOrder,
  placeTrailingStopOrder,
  unlockOperating,
} from "../core/order-coordinator";
import type { OrderLockMap, OrderPendingMap, OrderTimerMap } from "../core/order-coordinator";
import { extractMessage, isUnknownOrderError } from "../utils/errors";
import { roundDownToTick } from "../utils/math";
import { createTradeLog, type TradeLogEntry } from "../logging/trade-log";
import { isRateLimitError } from "../utils/errors";
import { RateLimitController } from "../core/lib/rate-limit";
import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe, type LogHandler } from "./common/subscriptions";
import { SessionVolumeTracker } from "./common/session-volume";

export interface RsiEngineSnapshot {
  ready: boolean;
  symbol: string;
  lastPrice: number | null;
  sma30: number | null;
  rsi: number | null;
  trend: "Comprado" | "Vendido" | "Sem sinal";
  position: PositionSnapshot;
  pnl: number;
  unrealized: number;
  totalProfit: number;
  totalTrades: number;
  sessionVolume: number;
  tradeLog: TradeLogEntry[];
  openOrders: AsterOrder[];
  depth: AsterDepth | null;
  ticker: AsterTicker | null;
  lastUpdated: number | null;
  lastOpenSignal: OpenOrderPlan;
}

export interface OpenOrderPlan {
  side: "BUY" | "SELL" | null;
  price: number | null;
}

type RsiEngineEvent = "update";

type RsiEngineListener = (snapshot: RsiEngineSnapshot) => void;

export class RsiEngine {
  private accountSnapshot: AsterAccountSnapshot | null = null;
  private openOrders: AsterOrder[] = [];
  private depthSnapshot: AsterDepth | null = null;
  private tickerSnapshot: AsterTicker | null = null;
  private klineSnapshot: AsterKline[] = [];

  private readonly locks: OrderLockMap = {};
  private readonly timers: OrderTimerMap = {};
  private readonly pending: OrderPendingMap = {};

  private readonly tradeLog: ReturnType<typeof createTradeLog>;
  private readonly events = new StrategyEventEmitter<RsiEngineEvent, RsiEngineSnapshot>();
  private readonly sessionVolume = new SessionVolumeTracker();

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private lastPrice: number | null = null;
  private lastSma30: number | null = null;
  private lastRsi: number | null = null;
  private totalProfit = 0;
  private totalTrades = 0;
  private lastOpenPlan: OpenOrderPlan = { side: null, price: null };
  private cancelAllRequested = false;
  private readonly pendingCancelOrders = new Set<string>();
  private readonly rateLimit: RateLimitController;
  private lastAccountPosition: PositionSnapshot = {
    positionAmt: 0,
    entryPrice: 0,
    unrealizedProfit: 0,
    markPrice: null,
  };
  private pendingRealized: { pnl: number; timestamp: number } | null = null;

  private lastEntryMinute: number | null;
  private lastStopLossAt: number | null;

  private ordersSnapshotReady = false;
  private startupLogged = false;
  private entryPricePendingLogged = false;

  constructor(private readonly config: TradingConfig, private readonly exchange: ExchangeAdapter) {
    this.tradeLog = createTradeLog(this.config.maxLogEntries);
    this.rateLimit = new RateLimitController(this.config.pollIntervalMs, (type, detail) =>
      this.tradeLog.push(type, detail)
    );
    this.bootstrap();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  on(event: RsiEngineEvent, handler: RsiEngineListener): void {
    this.events.on(event, handler);
  }

  off(event: RsiEngineEvent, handler: RsiEngineListener): void {
    this.events.off(event, handler);
  }

  getSnapshot(): RsiEngineSnapshot {
    return this.buildSnapshot();
  }

  private bootstrap(): void {
    const log: LogHandler = (type, detail) => this.tradeLog.push(type, detail);

    safeSubscribe<AsterAccountSnapshot>(
      this.exchange.watchAccount.bind(this.exchange),
      (snapshot) => {
        this.accountSnapshot = snapshot;
        const position = getPosition(snapshot, this.config.symbol);
        const reference = this.getReferencePrice();
        this.sessionVolume.update(position, reference);
        this.trackPositionLifecycle(position, reference);
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `Falha ao inscrever-se na conta: ${String(error)}`,
        processFail: (error) => `Exceção no processamento do push da conta: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterOrder[]>(
      this.exchange.watchOrders.bind(this.exchange),
      (orders) => {
        this.synchronizeLocks(orders);
        this.openOrders = Array.isArray(orders)
          ? orders.filter((order) => order.type !== "MARKET" && order.symbol === this.config.symbol)
          : [];
        const currentIds = new Set(this.openOrders.map((order) => String(order.orderId)));
        for (const id of Array.from(this.pendingCancelOrders)) {
          if (!currentIds.has(id)) {
            this.pendingCancelOrders.delete(id);
          }
        }
        if (this.openOrders.length === 0 || this.pendingCancelOrders.size === 0) {
          this.cancelAllRequested = false;
        }
        this.ordersSnapshotReady = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `Falha ao inscrever-se em ordens: ${String(error)}`,
        processFail: (error) => `Exceção no processamento do push de ordens: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterDepth>(
      this.exchange.watchDepth.bind(this.exchange, this.config.symbol),
      (depth) => {
        this.depthSnapshot = depth;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `Falha ao inscrever-se na profundidade: ${String(error)}`,
        processFail: (error) => `Exceção no processamento do push de profundidade: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterTicker>(
      this.exchange.watchTicker.bind(this.exchange, this.config.symbol),
      (ticker) => {
        this.tickerSnapshot = ticker;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `Falha ao inscrever-se no ticker: ${String(error)}`,
        processFail: (error) => `Exceção no processamento do push de preço: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterKline[]>(
      this.exchange.watchKlines.bind(this.exchange, this.config.symbol, this.config.klineInterval),
      (klines) => {
        this.klineSnapshot = Array.isArray(klines) ? klines : [];
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `Falha ao inscrever-se em K-lines: ${String(error)}`,
        processFail: (error) => `Exceção no processamento do push de K-line: ${extractMessage(error)}`,
      }
    );
  }

  private synchronizeLocks(orders: AsterOrder[] | null | undefined): void {
    const list = Array.isArray(orders) ? orders : [];
    Object.keys(this.pending).forEach((type) => {
      const pendingId = this.pending[type];
      if (!pendingId) return;
      const match = list.find((order) => String(order.orderId) === pendingId);
      if (!match || (match.status && match.status !== "NEW")) {
        unlockOperating(this.locks, this.timers, this.pending, type);
      }
    });
  }

  private isReady(): boolean {
    const minKlines = Math.max(30, 14); // Assuming RSI period of 14
    return Boolean(
      this.accountSnapshot &&
        this.tickerSnapshot &&
        this.depthSnapshot &&
        this.klineSnapshot.length >= minKlines
    );
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    let hadRateLimit = false;
    try {
      const decision = this.rateLimit.beforeCycle();
      if (decision === "paused") {
        this.emitUpdate();
        return;
      }
      if (decision === "skip") {
        return;
      }
      if (!this.ordersSnapshotReady) {
        this.emitUpdate();
        return;
      }
      if (!this.isReady()) {
        this.emitUpdate();
        return;
      }
      this.logStartupState();
      const sma30 = getSMA(this.klineSnapshot, 30);
      const rsi = getRSI(this.klineSnapshot, 14); // Assuming RSI period of 14
      if (sma30 == null || rsi == null) {
        return;
      }
      const ticker = this.tickerSnapshot!;
      const price = Number(ticker.lastPrice);
      const position = getPosition(this.accountSnapshot, this.config.symbol);

      if (Math.abs(position.positionAmt) < 1e-5) {
        if (!this.rateLimit.shouldBlockEntries()) {
          await this.handleOpenPosition(price, sma30, rsi);
        }
      } else {
        const result = await this.handlePositionManagement(position, price);
        if (result.closed) {
          this.pendingRealized = { pnl: result.pnl, timestamp: Date.now() };
        }
      }

      this.sessionVolume.update(position, price);
      this.trackPositionLifecycle(position, price);
      this.lastSma30 = sma30;
      this.lastRsi = rsi;
      this.lastPrice = price;
      this.emitUpdate();
    } catch (error) {
      if (isRateLimitError(error)) {
        hadRateLimit = true;
        this.rateLimit.registerRateLimit("rsi");
        await this.enforceRateLimitStop();
        this.tradeLog.push("warn", `RsiEngine 429: ${String(error)}`);
      } else {
        this.tradeLog.push("error", `Exceção no ciclo da estratégia: ${String(error)}`);
      }
      this.emitUpdate();
    } finally {
      try {
        this.rateLimit.onCycleComplete(hadRateLimit);
      } catch (rateLimitError) {
        this.tradeLog.push("error", `Falha ao atualizar o estado do controlador de limite de taxa: ${String(rateLimitError)}`);
      } finally {
        this.processing = false;
      }
    }
  }

  private async enforceRateLimitStop(): Promise<void> {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    if (Math.abs(position.positionAmt) < 1e-5) return;
    const price = this.getReferencePrice() ?? Number(this.tickerSnapshot?.lastPrice) ?? this.lastPrice;
    if (!Number.isFinite(price) || price == null) return;
    const result = await this.handlePositionManagement(position, Number(price));
    if (result.closed) {
      this.pendingRealized = { pnl: result.pnl, timestamp: Date.now() };
    }
  }

  private logStartupState(): void {
    if (this.startupLogged) return;
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const hasPosition = Math.abs(position.positionAmt) > 1e-5;
    if (hasPosition) {
      this.tradeLog.push(
        "info",
        `Posição existente detectada: ${position.positionAmt > 0 ? "Comprado" : "Vendido"} ${Math.abs(position.positionAmt).toFixed(4)} @ ${position.entryPrice.toFixed(2)}`
      );
    }
    if (this.openOrders.length > 0) {
      this.tradeLog.push("info", `Ordens pendentes detectadas: ${this.openOrders.length} ordens, serão assumidas pelas regras da estratégia`);
    }
    this.startupLogged = true;
  }

  private async handleOpenPosition(
    currentPrice: number,
    currentSma: number,
    currentRsi: number
  ): Promise<void> {
    this.entryPricePendingLogged = false;
    const now = Date.now();
    const currentMinute = Math.floor(now / 60_000);

    const RSI_OVERSOLD = 25; // Default value
    const RSI_OVERBOUGHT = 75; // Default value

    // Buy if RSI crosses above oversold
    if (currentRsi > RSI_OVERSOLD && this.lastRsi <= RSI_OVERSOLD) {
      await this.submitMarketOrder("BUY", currentPrice, "RSI cruzou acima de 25, abrindo posição comprada a mercado");
      this.lastEntryMinute = currentMinute;
    } 
    // Sell if RSI crosses below overbought
    else if (currentRsi < RSI_OVERBOUGHT && this.lastRsi >= RSI_OVERBOUGHT) {
      await this.submitMarketOrder("SELL", currentPrice, "RSI cruzou abaixo de 75, abrindo posição vendida a mercado");
      this.lastEntryMinute = currentMinute;
    }
  }

  private async submitMarketOrder(side: "BUY" | "SELL", price: number, reason: string): Promise<void> {
    try {
      await placeMarketOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        this.config.tradeAmount,
        (type, detail) => this.tradeLog.push(type, detail),
        false,
        {
          markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
          expectedPrice: Number(this.tickerSnapshot?.lastPrice) || null,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { qtyStep: this.config.qtyStep }
      );
      this.tradeLog.push("open", `${reason}: ${side} @ ${price}`);
      this.lastOpenPlan = { side, price };
    } catch (err) {
      this.tradeLog.push("error", `Falha ao colocar ordem a mercado: ${String(err)}`);
    }
  }

  private async handlePositionManagement(
    position: PositionSnapshot,
    price: number
  ): Promise<{ closed: boolean; pnl: number }> {
    const hasEntryPrice = Number.isFinite(position.entryPrice) && Math.abs(position.entryPrice) > 1e-8;
    if (!hasEntryPrice) {
      if (!this.entryPricePendingLogged) {
        this.tradeLog.push("info", "Preço médio de posição não sincronizado, aguardando atualização do snapshot da conta da exchange antes de executar o controle de risco");
        this.entryPricePendingLogged = true;
      }
      return { closed: false, pnl: position.unrealizedProfit };
    }
    this.entryPricePendingLogged = false;
    const direction = position.positionAmt > 0 ? "long" : "short";
    const pnl =
      (direction === "long"
        ? price - position.entryPrice
        : position.entryPrice - price) * Math.abs(position.positionAmt);
    const unrealized = Number.isFinite(position.unrealizedProfit)
      ? position.unrealizedProfit
      : null;
    const stopSide = direction === "long" ? "SELL" : "BUY";
    const stopPrice = calcStopLossPrice(
      position.entryPrice,
      Math.abs(position.positionAmt),
      direction,
      this.config.lossLimit
    );
    const activationPrice = calcTrailingActivationPrice(
      position.entryPrice,
      Math.abs(position.positionAmt),
      direction,
      this.config.trailingProfit
    );

    const currentStop = this.openOrders.find(
      (o) => o.type === "STOP_MARKET" && o.side === stopSide
    );
    const currentTrailing = this.openOrders.find(
      (o) => o.type === "TRAILING_STOP_MARKET" && o.side === stopSide
    );

    // Placeholder for RSI exit logic
    // Example: Close position if RSI crosses above 70 (for long) or below 30 (for short)
    const rsi = getRSI(this.klineSnapshot, 14);
    const RSI_EXIT_LEVEL = 50; // Default value

    if (rsi != null) {
      if (direction === "long" && rsi < RSI_EXIT_LEVEL) {
        this.tradeLog.push("close", "RSI abaixo de 50 para posição comprada, fechando a mercado");
        await this.flushOrders();
        await marketClose(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          "SELL",
          Math.abs(position.positionAmt),
          (type, detail) => this.tradeLog.push(type, detail),
          {
            markPrice: position.markPrice,
            expectedPrice: Number(this.depthSnapshot?.bids?.[0]?.[0]) || null,
            maxPct: this.config.maxCloseSlippagePct,
          },
          { qtyStep: this.config.qtyStep }
        );
        return { closed: true, pnl };
      } else if (direction === "short" && rsi > RSI_EXIT_LEVEL) {
        this.tradeLog.push("close", "RSI acima de 50 para posição vendida, fechando a mercado");
        await this.flushOrders();
        await marketClose(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          "BUY",
          Math.abs(position.positionAmt),
          (type, detail) => this.tradeLog.push(type, detail),
          {
            markPrice: position.markPrice,
            expectedPrice: Number(this.depthSnapshot?.asks?.[0]?.[0]) || null,
            maxPct: this.config.maxCloseSlippagePct,
          },
          { qtyStep: this.config.qtyStep }
        );
        return { closed: true, pnl };
      }
    }

    return { closed: false, pnl };
  }

  private async flushOrders(): Promise<void> {
    if (!this.openOrders.length) return;
    for (const order of this.openOrders) {
      if (this.pendingCancelOrders.has(String(order.orderId))) continue;
      this.pendingCancelOrders.add(String(order.orderId));
      await safeCancelOrder(
        this.exchange,
        this.config.symbol,
        order,
        () => {
          // Mantém a consistência com a lógica original: cancelamento bem-sucedido não registra log e não modifica openOrders locais
        },
        () => {
          this.tradeLog.push("order", "Ordem não existe mais, cancelamento ignorado");
          this.pendingCancelOrders.delete(String(order.orderId));
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        },
        (error) => {
          this.tradeLog.push("error", `Falha ao cancelar ordem: ${String(error)}`);
          this.pendingCancelOrders.delete(String(order.orderId));
          // Mantém a consistência com o caminho de cancelamento síncrono, remove ordens locais anormais e aguarda a reconstrução do fluxo de ordens
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        }
      );
    }
  }

  private emitUpdate(): void {
    try {
      const snapshot = this.buildSnapshot();
      this.events.emit("update", snapshot, (error) => {
        this.tradeLog.push("error", `Exceção no tratamento do callback de atualização: ${String(error)}`);
      });
    } catch (err) {
      this.tradeLog.push("error", `Exceção na distribuição de snapshot ou atualização: ${String(err)}`);
    }
  }

  private buildSnapshot(): RsiEngineSnapshot {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const price = this.tickerSnapshot ? Number(this.tickerSnapshot.lastPrice) : null;
    const sma30 = this.lastSma30;
    const rsi = this.lastRsi;
    const trend = price == null || rsi == null
      ? "Sem sinal"
      : rsi < 30
      ? "Comprado"
      : rsi > 70
      ? "Vendido"
      : "Sem sinal";
    const pnl = price != null ? computePositionPnl(position, price, price) : 0;
    return {
      ready: this.isReady(),
      symbol: this.config.symbol,
      lastPrice: price,
      sma30,
      rsi,
      trend,
      position,
      pnl,
      unrealized: position.unrealizedProfit,
      totalProfit: this.totalProfit,
      totalTrades: this.totalTrades,
      sessionVolume: this.sessionVolume.value,
      tradeLog: this.tradeLog.all(),
      openOrders: this.openOrders,
      depth: this.depthSnapshot,
      ticker: this.tickerSnapshot,
      lastUpdated: Date.now(),
      lastOpenSignal: this.lastOpenPlan,
    };
  }

  private getReferencePrice(): number | null {
    return getMidOrLast(this.depthSnapshot, this.tickerSnapshot) ?? (this.lastPrice != null && Number.isFinite(this.lastPrice) ? this.lastPrice : null);
  }

  private trackPositionLifecycle(position: PositionSnapshot, referencePrice: number | null): void {
    const prev = this.lastAccountPosition;
    const prevExposure = Math.abs(prev.positionAmt) > 1e-5;
    const currentExposure = Math.abs(position.positionAmt) > 1e-5;
    const signChanged =
      prevExposure && currentExposure && Math.sign(prev.positionAmt) !== Math.sign(position.positionAmt);

    if (prevExposure && (!currentExposure || signChanged)) {
      let realized: number | null = this.pendingRealized?.pnl ?? null;
      if (!Number.isFinite(realized)) {
        realized = this.estimateRealizedPnl(prev, referencePrice);
      }
      if (Number.isFinite(realized)) {
        this.totalTrades += 1;
        this.totalProfit += realized ?? 0;
      }
      this.pendingRealized = null;
    }

    if (!prevExposure && currentExposure) {
      this.pendingRealized = null;
    }

    this.lastAccountPosition = {
      positionAmt: position.positionAmt,
      entryPrice: position.entryPrice,
      unrealizedProfit: position.unrealizedProfit,
      markPrice: position.markPrice,
    };
  }

  private estimateRealizedPnl(position: PositionSnapshot, referencePrice: number | null): number {
    const fallbackPrice =
      referencePrice ??
      this.getReferencePrice() ??
      (this.lastPrice != null && Number.isFinite(this.lastPrice) ? this.lastPrice : position.entryPrice);
    if (!Number.isFinite(fallbackPrice)) {
      return 0;
    }
    return computePositionPnl(position, fallbackPrice, fallbackPrice);
  }
}

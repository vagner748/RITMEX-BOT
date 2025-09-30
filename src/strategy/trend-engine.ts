import crypto from "crypto";
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
  calcStopLossPrice,
  calcTrailingActivationPrice,
  computeBollingerBandwidth,
  getPosition,
  getSMA,
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
import { decryptCopyright } from "../utils/copyright";
import { isRateLimitError } from "../utils/errors";
import { RateLimitController } from "../core/lib/rate-limit";
import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe, type LogHandler } from "./common/subscriptions";
import { SessionVolumeTracker } from "./common/session-volume";
import type { Strategy } from "../core/order-coordinator";

export interface TrendEngineSnapshot {
  ready: boolean;
  symbol: string;
  lastPrice: number | null;
  sma30: number | null;
  bollingerBandwidth: number | null;
  trend: "Comprado" | "Vendido" | "Sem sinal";
  // Controla a frequência de entrada: no máximo uma entrada por minuto
  private lastEntryMinute: number | null;
  // Resfriamento após stop-loss: ignora sinais de entrada SMA por 60s após um stop-loss
  private lastStopLossAt: number | null;
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

type TrendEngineEvent = "update";

type TrendEngineListener = (snapshot: TrendEngineSnapshot) => void;

export class TrendEngine {
  private accountSnapshot: AsterAccountSnapshot | null = null;
  private openOrders: AsterOrder[] = [];
  private depthSnapshot: AsterDepth | null = null;
  private tickerSnapshot: AsterTicker | null = null;
  private klineSnapshot: AsterKline[] = [];

  private readonly locks: OrderLockMap = {};
  private readonly timers: OrderTimerMap = {};
  private readonly pending: OrderPendingMap = {};

  private readonly tradeLog: ReturnType<typeof createTradeLog>;
  private readonly events = new StrategyEventEmitter<TrendEngineEvent, TrendEngineSnapshot>();
  private readonly sessionVolume = new SessionVolumeTracker();
  private readonly strategy: Strategy = "trend";

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private lastPrice: number | null = null;
  private lastSma30: number | null = null;
  private lastBollingerBandwidth: number | null = null;
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

  // 控制入场频率：同一分钟内最多入场一次
  private lastEntryMinute: number | null;
    private lastStopLossAt: number | null;
  private lastBollingerBlockLogged = 0;

  private ordersSnapshotReady = false;
  private startupLogged = false;
  private entryPricePendingLogged = false;
  private readonly copyrightFingerprint = crypto
    .createHash("sha256")
    .update(decryptCopyright())
    .digest("hex");

  private readonly listeners = new Map<TrendEngineEvent, Set<TrendEngineListener>>();

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

  on(event: TrendEngineEvent, handler: TrendEngineListener): void {
    this.events.on(event, handler);
  }

  off(event: TrendEngineEvent, handler: TrendEngineListener): void {
    this.events.off(event, handler);
  }

  getSnapshot(): TrendEngineSnapshot {
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
    const minKlines = Math.max(30, this.config.bollingerLength);
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
      if (sma30 == null) {
        return;
      }
      const bollingerBandwidth = computeBollingerBandwidth(
        this.klineSnapshot,
        this.config.bollingerLength,
        this.config.bollingerStdMultiplier
      );
      this.lastBollingerBandwidth = bollingerBandwidth;
      const ticker = this.tickerSnapshot!;
      const price = Number(ticker.lastPrice);
      const position = getPosition(this.accountSnapshot, this.config.symbol);

      if (Math.abs(position.positionAmt) < 1e-5) {
        if (!this.rateLimit.shouldBlockEntries()) {
          await this.handleOpenPosition(price, sma30, bollingerBandwidth);
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
      this.lastPrice = price;
      this.emitUpdate();
    } catch (error) {
      if (isRateLimitError(error)) {
        hadRateLimit = true;
        this.rateLimit.registerRateLimit("trend");
        await this.enforceRateLimitStop();
        this.tradeLog.push("warn", `TrendEngine 429: ${String(error)}`);
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
    currentBandwidth: number | null
  ): Promise<void> {
    this.entryPricePendingLogged = false;
    const now = Date.now();
    const currentMinute = Math.floor(now / 60_000);
    // Período de resfriamento após stop-loss: não permite nova entrada baseada em cruzamento de SMA por 60s
    if (this.lastStopLossAt != null && now - this.lastStopLossAt < 60_000) {
      const remaining = Math.max(0, 60_000 - (now - this.lastStopLossAt));
      this.tradeLog.push("info", `Resfriamento após stop-loss: ${remaining / 1000}s restantes, ignorando sinal de entrada`);
      return;
    }
    // Apenas uma entrada por minuto
    if (this.lastEntryMinute != null && this.lastEntryMinute === currentMinute) {
      this.tradeLog.push("info", "Já houve uma entrada neste minuto, ignorando novos sinais de entrada SMA");
      return;
    }
    if (
      Number.isFinite(currentBandwidth) &&
      this.config.minBollingerBandwidth > 0 &&
      Number(currentBandwidth) < this.config.minBollingerBandwidth
    ) {
      if (now - this.lastBollingerBlockLogged > 15_000) {
        this.tradeLog.push(
          "info",
          `Largura da Banda de Bollinger insuficiente: ${Number(currentBandwidth).toFixed(4)} < ${this.config.minBollingerBandwidth}, ignorando sinal de entrada`
        );
        this.lastBollingerBlockLogged = now;
      }
      return;
    }
    if (this.lastPrice == null) {
      this.lastPrice = currentPrice;
      return;
    }
    if (this.openOrders.length > 0 && !this.cancelAllRequested) {
      try {
        await this.exchange.cancelAllOrders({ symbol: this.config.symbol });
        this.cancelAllRequested = true;
        // Limpa ordens locais pendentes e fila de cancelamento para evitar operar com snapshots desatualizados na próxima rodada
        this.pendingCancelOrders.clear();
        this.openOrders = [];
      } catch (err) {
        if (isUnknownOrderError(err)) {
          this.tradeLog.push("order", "Algumas ordens não existiam ao cancelar, ignorando");
          this.cancelAllRequested = true;
          // Mantém a consistência com o caminho de cancelamento bem-sucedido, limpa imediatamente o cache local e aguarda a reconstrução do fluxo de ordens
          this.pendingCancelOrders.clear();
          this.openOrders = [];
        } else {
          this.tradeLog.push("error", `Falha ao cancelar ordens pendentes: ${String(err)}`);
          this.cancelAllRequested = false;
        }
      }
    }
    if (this.lastPrice > currentSma && currentPrice < currentSma) {
      await this.submitMarketOrder("SELL", currentPrice, "Cruzou abaixo da SMA30, abrindo posição vendida a mercado");
      this.lastEntryMinute = currentMinute;
    } else if (this.lastPrice < currentSma && currentPrice > currentSma) {
      await this.submitMarketOrder("BUY", currentPrice, "Cruzou acima da SMA30, abrindo posição comprada a mercado");
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
        this.strategy,
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

    // Movimento de bloqueio de lucro em etapas: antes que o take-profit dinâmico seja ativado, o stop-loss é movido para cima/para baixo uma vez para cada profitLockOffsetUsd de lucro
    {
      const tick = Math.max(1e-9, this.config.priceTick);
      const qtyAbs = Math.abs(position.positionAmt);
      const stepUsd = Math.max(0, this.config.profitLockOffsetUsd);
      const triggerUsd = Math.max(0, this.config.profitLockTriggerUsd);
      const trailingActivateFromOrderRaw = currentTrailing?.activatePrice ?? (currentTrailing as any)?.activationPrice;
      const trailingActivateFromOrder = Number(trailingActivateFromOrderRaw);
      const trailingActivate = Number.isFinite(trailingActivateFromOrder)
        ? trailingActivateFromOrder
        : activationPrice;

      // Determina se o take-profit dinâmico foi ativado: para posições longas, price >= activate; para posições curtas, price <= activate
      const trailingActivated =
        direction === "long"
          ? Number.isFinite(trailingActivate) && price >= trailingActivate - tick
          : Number.isFinite(trailingActivate) && price <= trailingActivate + tick;

      // Executa o movimento gradual apenas se o take-profit dinâmico não estiver ativado
      if (!trailingActivated && qtyAbs > 0 && stepUsd > 0) {
        const basisProfit = Number.isFinite(unrealized ?? pnl) ? Math.max(pnl, unrealized ?? pnl) : pnl;
        if (basisProfit >= triggerUsd) {
          const over = basisProfit - triggerUsd;
          const steps = 1 + Math.floor(over / stepUsd);
          const stepPx = stepUsd / qtyAbs;
          const rawTarget = direction === "long"
            ? position.entryPrice + steps * stepPx
            : position.entryPrice - steps * stepPx;
          let targetStop = roundDownToTick(rawTarget, this.config.priceTick);

          // Não permite que o próximo movimento exceda o preço de ativação da ordem de take-profit dinâmico
          if (Number.isFinite(trailingActivate)) {
            if (stopSide === "SELL" && targetStop >= trailingActivate - tick) {
              // Atingiu ou excedeu o preço de ativação, para de mover
              targetStop = Math.min(targetStop, trailingActivate - tick);
              // Se não puder melhorar mais, não tenta novamente
              const existingRaw = Number(currentStop?.stopPrice);
              const existingPrice = Number.isFinite(existingRaw) ? existingRaw : NaN;
              const canImprove =
                !Number.isFinite(existingPrice) ||
                (stopSide === "SELL" && targetStop >= existingPrice + tick);
              if (!canImprove) {
                // Pula diretamente
                // no-op
              } else if (currentStop) {
                await this.tryReplaceStop(stopSide, currentStop, targetStop, price);
              } else {
                await this.tryPlaceStopLoss(stopSide, targetStop, price);
              }
            } else if (stopSide === "BUY" && targetStop <= trailingActivate + tick) {
              targetStop = Math.max(targetStop, trailingActivate + tick);
              const existingRaw = Number(currentStop?.stopPrice);
              const existingPrice = Number.isFinite(existingRaw) ? existingRaw : NaN;
              const canImprove =
                !Number.isFinite(existingPrice) ||
                (stopSide === "BUY" && targetStop <= existingPrice - tick);
              if (!canImprove) {
                // no-op
              } else if (currentStop) {
                await this.tryReplaceStop(stopSide, currentStop, targetStop, price);
              } else {
                await this.tryPlaceStopLoss(stopSide, targetStop, price);
              }
            } else {
              // Dentro do intervalo normal, e deve ser consistente com a direção do preço atual
              const validForSide =
                (stopSide === "SELL" && targetStop <= price - tick) ||
                (stopSide === "BUY" && targetStop >= price + tick);
              if (validForSide) {
                if (!currentStop) {
                  await this.tryPlaceStopLoss(stopSide, targetStop, price);
                } else {
                  const existingRaw = Number(currentStop.stopPrice);
                  const existingPrice = Number.isFinite(existingRaw) ? existingRaw : NaN;
                  const improves =
                    !Number.isFinite(existingPrice) ||
                    (stopSide === "SELL" && targetStop >= existingPrice + tick) ||
                    (stopSide === "BUY" && targetStop <= existingPrice - tick);
                  if (improves) {
                    await this.tryReplaceStop(stopSide, currentStop, targetStop, price);
                  }
                }
              }
            }
          } else {
            // Se não for possível obter o preço de ativação do take-profit dinâmico, segue a lógica de passo normal
            const validForSide =
              (stopSide === "SELL" && targetStop <= price - tick) ||
              (stopSide === "BUY" && targetStop >= price + tick);
            if (validForSide) {
              if (!currentStop) {
                await this.tryPlaceStopLoss(stopSide, targetStop, price);
              } else {
                const existingRaw = Number(currentStop.stopPrice);
                const existingPrice = Number.isFinite(existingRaw) ? existingRaw : NaN;
                const improves =
                  !Number.isFinite(existingPrice) ||
                  (stopSide === "SELL" && targetStop >= existingPrice + tick) ||
                  (stopSide === "BUY" && targetStop <= existingPrice - tick);
                if (improves) {
                  await this.tryReplaceStop(stopSide, currentStop, targetStop, price);
                }
              }
            }
          }
        }
      }
    }

    if (!currentStop) {
      await this.tryPlaceStopLoss(stopSide, roundDownToTick(stopPrice, this.config.priceTick), price);
    }

    if (!currentTrailing) {
      await this.tryPlaceTrailingStop(
        stopSide,
        roundDownToTick(activationPrice, this.config.priceTick),
        Math.abs(position.positionAmt),
        price
      );
    }

    const derivedLoss = pnl < -this.config.lossLimit;
    const snapshotLoss = Boolean(
      unrealized != null &&
        unrealized < -this.config.lossLimit &&
        pnl <= 0
    );

    if (derivedLoss || snapshotLoss) {
      const result = { closed: false, pnl };
      try {
        if (this.openOrders.length > 0) {
          const orderIdList = this.openOrders.map((order) => order.orderId);
          const orderIdSet = new Set(orderIdList.map(String));
          try {
            await this.exchange.cancelOrders({ symbol: this.config.symbol, orderIdList });
            orderIdSet.forEach((id) => this.pendingCancelOrders.add(id));
          } catch (err) {
            if (isUnknownOrderError(err)) {
              this.tradeLog.push("order", "Ordem de stop-loss original não existe mais, pulando cancelamento");
                // Limpa o cache local para evitar cancelamentos repetidos da mesma ordem
                for (const id of orderIdSet) {
                  this.pendingCancelOrders.delete(id);
                }
                this.openOrders = this.openOrders.filter((o) => !orderIdSet.has(String(o.orderId)));
            } else {
              throw err;
            }
          }
        }
        // Proteção contra manipulação de preço: só executa fechamento a mercado se o preço na direção de fechamento estiver dentro do limite de desvio do preço de marcação
        const mark = getPosition(this.accountSnapshot, this.config.symbol).markPrice;
        const limitPct = this.config.maxCloseSlippagePct;
        const sideIsSell = direction === "long";
        const depthBid = Number(this.depthSnapshot?.bids?.[0]?.[0]);
        const depthAsk = Number(this.depthSnapshot?.asks?.[0]?.[0]);
        const closeSidePrice = sideIsSell ? depthBid : depthAsk;
        if (mark != null && Number.isFinite(mark) && mark > 0 && Number.isFinite(closeSidePrice)) {
          const pctDiff = Math.abs(closeSidePrice - mark) / mark;
          if (pctDiff > limitPct) {
            this.tradeLog.push(
              "info",
              `Proteção de fechamento a mercado acionada: closePx=${Number(closeSidePrice).toFixed(2)} mark=${mark.toFixed(2)} desvio ${(pctDiff * 100).toFixed(2)}% > ${(limitPct * 100).toFixed(2)}%`
            );
            return { closed: false, pnl };
          }
        }
        await marketClose(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          this.strategy,
          direction === "long" ? "SELL" : "BUY",
          Math.abs(position.positionAmt),
          (type, detail) => this.tradeLog.push(type, detail),
          {
            markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
            expectedPrice: Number(
              direction === "long"
                ? this.depthSnapshot?.bids?.[0]?.[0]
                : this.depthSnapshot?.asks?.[0]?.[0]
            ) || null,
            maxPct: this.config.maxCloseSlippagePct,
        },
        { qtyStep: this.config.qtyStep }
        );
        result.closed = true;
        this.tradeLog.push("close", `Fechamento por stop-loss: ${direction === "long" ? "SELL" : "BUY"}`);
        // Registra o tempo do stop-loss para inibir novas entradas a curto prazo
        this.lastStopLossAt = Date.now();
      } catch (err) {
        if (isUnknownOrderError(err)) {
          this.tradeLog.push("order", "A ordem alvo não existe mais ao fechar a posição por stop-loss");
        } else {
          this.tradeLog.push("error", `Falha ao fechar a posição por stop-loss: ${String(err)}`);
        }
        return result;
      }
      return result;
    }

    return { closed: false, pnl };
  }

  private async tryPlaceStopLoss(
    side: "BUY" | "SELL",
    stopPrice: number,
    lastPrice: number
  ): Promise<void> {
    try {
      const position = getPosition(this.accountSnapshot, this.config.symbol);
      const quantity = Math.abs(position.positionAmt) || this.config.tradeAmount;
      await placeStopLossOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        this.strategy,
        side,
        stopPrice,
        quantity,
        lastPrice,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: position.markPrice,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
      );
    } catch (err) {
      this.tradeLog.push("error", `Falha ao colocar ordem de stop-loss: ${String(err)}`);
    }
  }

  private async tryReplaceStop(
    side: "BUY" | "SELL",
    currentOrder: AsterOrder,
    nextStopPrice: number,
    lastPrice: number
  ): Promise<void> {
    // Pré-verificação: o preço de stop-loss para VENDA deve ser menor que o preço atual; para COMPRA, deve ser maior que o preço atual
    const invalidForSide =
      (side === "SELL" && nextStopPrice >= lastPrice) ||
      (side === "BUY" && nextStopPrice <= lastPrice);
    if (invalidForSide) {
      // Ignora o movimento se o preço de stop-loss alvo entrar em conflito com o preço atual, para evitar ciclos de cancelamento/recolocação repetidos
      return;
    }
    const existingStopPrice = Number(currentOrder.stopPrice);
    try {
      await this.exchange.cancelOrder({ symbol: this.config.symbol, orderId: currentOrder.orderId });
    } catch (err) {
      if (isUnknownOrderError(err)) {
        this.tradeLog.push("order", "Ordem de stop-loss original não existe mais, pulando cancelamento");
        // A ordem não existe mais, remove o registro local para evitar correspondências repetidas futuras
        this.openOrders = this.openOrders.filter((o) => o.orderId !== currentOrder.orderId);
      } else {
        this.tradeLog.push("error", `Falha ao cancelar ordem de stop-loss original: ${String(err)}`);
      }
    }
    // Registra o log de "movimento de stop-loss" apenas após a criação bem-sucedida de uma nova ordem de stop-loss
    try {
      const position = getPosition(this.accountSnapshot, this.config.symbol);
      const quantity = Math.abs(position.positionAmt) || this.config.tradeAmount;
      const order = await placeStopLossOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        this.strategy,
        side,
        nextStopPrice,
        quantity,
        lastPrice,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: position.markPrice,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
      );
      if (order) {
        this.tradeLog.push("stop", `Movendo stop-loss para ${roundDownToTick(nextStopPrice, this.config.priceTick)}`);
      }
    } catch (err) {
      this.tradeLog.push("error", `Falha ao mover stop-loss: ${String(err)}`);
      // Estratégia de rollback: tenta restaurar o stop-loss com o preço original para evitar ficar sem proteção de stop-loss por um curto período
      try {
        const position = getPosition(this.accountSnapshot, this.config.symbol);
        const quantity = Math.abs(position.positionAmt) || this.config.tradeAmount;
        const restoreInvalid =
          (side === "SELL" && existingStopPrice >= lastPrice) ||
          (side === "BUY" && existingStopPrice <= lastPrice);
        if (!restoreInvalid) {
          const restored = await placeStopLossOrder(
            this.exchange,
            this.config.symbol,
            this.openOrders,
            this.locks,
            this.timers,
            this.pending,
            this.strategy,
            side,
            existingStopPrice,
            quantity,
            lastPrice,
            (t, d) => this.tradeLog.push(t, d),
            {
              markPrice: position.markPrice,
              maxPct: this.config.maxCloseSlippagePct,
            },
            { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
          );
          if (restored) {
            this.tradeLog.push("order", `Restaurando stop-loss original @ ${roundDownToTick(existingStopPrice, this.config.priceTick)}`);
          }
        }
      } catch (recoverErr) {
        this.tradeLog.push("error", `Falha ao restaurar stop-loss original: ${String(recoverErr)}`);
      }
    }
  }

  private async tryPlaceTrailingStop(
    side: "BUY" | "SELL",
    activationPrice: number,
    quantity: number,
    lastPrice: number
  ): Promise<void> {
    try {
      // Guard against invalid activation prices that would trigger immediately
      if (side === "BUY" && activationPrice <= lastPrice) {
        return; // Activation price for BUY must be above the current price
      }
      if (side === "SELL" && activationPrice >= lastPrice) {
        return; // Activation price for SELL must be below the current price
      }

      await placeTrailingStopOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        this.strategy,
        side,
        activationPrice,
        quantity,
        this.config.trailingCallbackRate,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
      );
    } catch (err) {
      this.tradeLog.push("error", `Falha ao colocar ordem de trailing stop: ${String(err)}`);
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

  private buildSnapshot(): TrendEngineSnapshot {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const price = this.tickerSnapshot ? Number(this.tickerSnapshot.lastPrice) : null;
    const sma30 = this.lastSma30;
    const trend = price == null || sma30 == null
      ? "Sem sinal"
      : price > sma30
      ? "Comprado"
      : price < sma30
      ? "Vendido"
      : "Sem sinal";
    const pnl = price != null ? computePositionPnl(position, price, price) : 0;
    return {
      ready: this.isReady(),
      symbol: this.config.symbol,
      lastPrice: price,
      sma30,
      bollingerBandwidth: this.lastBollingerBandwidth,
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

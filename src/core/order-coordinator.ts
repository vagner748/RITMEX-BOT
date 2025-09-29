import type { ExchangeAdapter } from "../exchanges/adapter";
import type { AsterOrder, CreateOrderParams } from "../exchanges/types";
import { roundDownToTick, roundQtyDownToStep } from "../utils/math";
import { isUnknownOrderError } from "../utils/errors";
import { isOrderPriceAllowedByMark } from "../utils/strategy";

export type OrderLockMap = Record<string, boolean>;
export type OrderTimerMap = Record<string, ReturnType<typeof setTimeout> | null>;
export type OrderPendingMap = Record<string, string | null>;
export type LogHandler = (type: string, detail: string) => void;
export type Strategy = "trend" | "maker" | "grid" | "rsi" | "sma-rsi";

type OrderGuardOptions = {
  markPrice?: number | null;
  expectedPrice?: number | null;
  maxPct?: number;
};

function getLockKey(strategy: Strategy, type: string): string {
  return `${strategy}_${type}`;
}

function enforceMarkPriceGuard(
  side: "BUY" | "SELL",
  toCheckPrice: number | null | undefined,
  guard: OrderGuardOptions | undefined,
  log: LogHandler,
  context: string
): boolean {
  if (!guard || guard.maxPct == null) return true;
  const allowed = isOrderPriceAllowedByMark({
    side,
    orderPrice: toCheckPrice,
    markPrice: guard.markPrice,
    maxPct: guard.maxPct,
  });
  if (!allowed) {
    const priceStr = Number.isFinite(Number(toCheckPrice)) ? Number(toCheckPrice).toFixed(2) : String(toCheckPrice);
    const markStr = Number.isFinite(Number(guard.markPrice)) ? Number(guard.markPrice).toFixed(2) : String(guard.markPrice);
    log(
      "info",
      `${context} Proteção acionada: side=${side} price=${priceStr} mark=${markStr} excede ${(guard.maxPct! * 100).toFixed(2)}%`
    );
    return false;
  }
  return true;
}

export function isOperating(locks: OrderLockMap, strategy: Strategy, type: string): boolean {
  return Boolean(locks[getLockKey(strategy, type)]);
}

export function lockOperating(
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  strategy: Strategy,
  type: string,
  log: LogHandler,
  timeout = 10000
): void {
  const lockKey = getLockKey(strategy, type);
  locks[lockKey] = true;
  if (timers[lockKey]) {
    clearTimeout(timers[lockKey]!);
  }
  timers[lockKey] = setTimeout(() => {
    locks[lockKey] = false;
    pendings[lockKey] = null;
    log("info", `${lockKey} operação desbloqueada automaticamente por timeout`);
  }, timeout);
}

export function unlockOperating(
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  strategy: Strategy,
  type: string
): void {
  const lockKey = getLockKey(strategy, type);
  locks[lockKey] = false;
  pendings[lockKey] = null;
  if (timers[lockKey]) {
    clearTimeout(timers[lockKey]!);
  }
  timers[lockKey] = null;
}

export function getOrdersByStrategy(openOrders: AsterOrder[], strategy: Strategy): AsterOrder[] {
  return openOrders.filter(o => o.clientOrderId?.startsWith(`${strategy}_`));
}

export async function cancelOrdersByStrategy(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  strategy: Strategy,
  log: LogHandler
): Promise<void> {
  const strategyOrders = getOrdersByStrategy(openOrders, strategy);
  if (strategyOrders.length === 0) return;

  const orderIdList = strategyOrders.map(o => o.orderId);
  try {
    await adapter.cancelOrders({ symbol, orderIdList });
    log("order", `Cancelando todas as ordens (${orderIdList.length}) da estratégia ${strategy}`);
  } catch (err) {
    if (isUnknownOrderError(err)) {
      log("order", `Ordens da estratégia ${strategy} não encontradas ao cancelar, pulando.`);
    } else {
      log("error", `Falha ao cancelar ordens da estratégia ${strategy}: ${String(err)}`);
    }
  }
}

export async function deduplicateOrders(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  strategy: Strategy,
  type: string,
  side: string,
  log: LogHandler
): Promise<void> {
  const sameTypeOrders = getOrdersByStrategy(openOrders, strategy).filter((o) => o.type === type && o.side === side);

  if (sameTypeOrders.length <= 1) return;
  sameTypeOrders.sort((a, b) => (b.updateTime || b.time || 0) - (a.updateTime || a.time || 0));
  const toCancel = sameTypeOrders.slice(1);
  const orderIdList = toCancel.map((o) => o.orderId);
  if (!orderIdList.length) return;
  try {
    lockOperating(locks, timers, pendings, strategy, type, log);
    await adapter.cancelOrders({ symbol, orderIdList });
    log("order", `[${strategy}] Cancelando ordens duplicadas tipo ${type}: ${orderIdList.join(",")}`);
  } catch (err) {
    if (isUnknownOrderError(err)) {
      log("order", "Ordem não encontrada ao remover duplicatas, pulando exclusão");
    } else {
      log("error", `Falha ao cancelar ordem para remover duplicata: ${String(err)}`);
    }
  } finally {
    unlockOperating(locks, timers, pendings, strategy, type);
  }
}

export async function placeOrder(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  strategy: Strategy,
  side: "BUY" | "SELL",
  price: number,
  amount: number,
  log: LogHandler,
  clientOrderId: string,
  reduceOnly = false,
  guard?: OrderGuardOptions,
  opts?: { priceTick: number; qtyStep: number }
): Promise<AsterOrder | undefined> {
  const type = "LIMIT";
  if (isOperating(locks, strategy, type)) return;
  if (!enforceMarkPriceGuard(side, price, guard, log, "Ordem Limite")) return;
  const priceTick = opts?.priceTick ?? 0.1;
  const qtyStep = opts?.qtyStep ?? 0.001;
  const params: CreateOrderParams = {
    symbol,
    side,
    type,
    quantity: roundQtyDownToStep(amount, qtyStep),
    price: roundDownToTick(price, priceTick),
    timeInForce: "GTX",
    newClientOrderId: clientOrderId,
  };
  if (reduceOnly) params.reduceOnly = "true";
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, strategy, type, side, log);
  lockOperating(locks, timers, pendings, strategy, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[getLockKey(strategy, type)] = String(order.orderId);
    log("order", `[${strategy}] Colocando ordem limite: ${side} @ ${params.price} quantidade ${params.quantity} reduceOnly=${reduceOnly}`);
    return order;
  } catch (err) {
    unlockOperating(locks, timers, pendings, strategy, type);
    if (isUnknownOrderError(err)) {
      log("order", "Ordem já executada ou cancelada, pulando nova ordem");
      return undefined;
    }
    throw err;
  }
}

export async function placeMarketOrder(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  strategy: Strategy,
  side: "BUY" | "SELL",
  amount: number,
  log: LogHandler,
  reduceOnly = false,
  guard?: OrderGuardOptions,
  opts?: { qtyStep: number }
): Promise<AsterOrder | undefined> {
  const type = "MARKET";
  if (isOperating(locks, strategy, type)) return;
  if (!enforceMarkPriceGuard(side, guard?.expectedPrice ?? null, guard, log, "Ordem a Mercado")) return;
  const qtyStep = opts?.qtyStep ?? 0.001;
  const params: CreateOrderParams = {
    symbol,
    side,
    type,
    quantity: roundQtyDownToStep(amount, qtyStep),
  };
  if (reduceOnly) params.reduceOnly = "true";
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, strategy, type, side, log);
  lockOperating(locks, timers, pendings, strategy, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[getLockKey(strategy, type)] = String(order.orderId);
    log("order", `[${strategy}] Ordem a mercado: ${side} quantidade ${params.quantity} reduceOnly=${reduceOnly}`);
    return order;
  } catch (err) {
    unlockOperating(locks, timers, pendings, strategy, type);
    if (isUnknownOrderError(err)) {
      log("order", "Falha na ordem a mercado, mas a ordem não existe mais, ignorando");
      return undefined;
    }
    throw err;
  }
}

export async function marketClose(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  strategy: Strategy,
  side: "BUY" | "SELL",
  quantity: number,
  log: LogHandler,
  guard?: OrderGuardOptions,
  opts?: { qtyStep: number }
): Promise<void> {
  const type = "MARKET";
  if (isOperating(locks, strategy, type)) return;
  if (!enforceMarkPriceGuard(side, guard?.expectedPrice ?? null, guard, log, "Fechamento a Mercado")) return;
  const qtyStep = opts?.qtyStep ?? 0.001;
  const params: CreateOrderParams = {
    symbol,
    side,
    type,
    quantity: roundQtyDownToStep(quantity, qtyStep),
    reduceOnly: "true",
  };
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, strategy, type, side, log);
  lockOperating(locks, timers, pendings, strategy, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[getLockKey(strategy, type)] = String(order.orderId);
    log("close", `[${strategy}] Fechamento a mercado: ${side}`);
  } catch (err) {
    unlockOperating(locks, timers, pendings, strategy, type);
    if (isUnknownOrderError(err)) {
      log("order", "Ordem não existe mais ao fechar a mercado");
      return;
    }
    throw err;
  }
}

export async function placeStopLossOrder(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  strategy: Strategy,
  side: "BUY" | "SELL",
  stopPrice: number,
  quantity: number,
  lastPrice: number | null,
  log: LogHandler,
  guard?: OrderGuardOptions,
  opts?: { priceTick: number; qtyStep: number }
): Promise<AsterOrder | undefined> {
  const type = "STOP_MARKET";
  if (isOperating(locks, strategy, type)) return;
  if (!enforceMarkPriceGuard(side, stopPrice, guard, log, "Ordem Stop")) return;
  if (lastPrice != null) {
    if (side === "SELL" && stopPrice >= lastPrice) {
      log("error", `Preço de stop ${stopPrice} é maior ou igual ao preço atual ${lastPrice}, cancelando ordem`);
      return;
    }
    if (side === "BUY" && stopPrice <= lastPrice) {
      log("error", `Preço de stop ${stopPrice} é menor ou igual ao preço atual ${lastPrice}, cancelando ordem`);
      return;
    }
  }
  const priceTick = opts?.priceTick ?? 0.1;
  const qtyStep = opts?.qtyStep ?? 0.001;
  const params: CreateOrderParams = {
    symbol,
    side,
    type,
    stopPrice: roundDownToTick(stopPrice, priceTick),
    closePosition: "true",
    timeInForce: "GTC",
    quantity: roundQtyDownToStep(quantity, qtyStep),
  };
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, strategy, type, side, log);
  lockOperating(locks, timers, pendings, strategy, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[getLockKey(strategy, type)] = String(order.orderId);
    log("stop", `[${strategy}] Colocando ordem stop: ${side} STOP_MARKET @ ${params.stopPrice}`);
    return order;
  } catch (err) {
    unlockOperating(locks, timers, pendings, strategy, type);
    if (isUnknownOrderError(err)) {
      log("order", "Ordem stop já inválida, pulando");
      return undefined;
    }
    throw err;
  }
}

export async function placeTrailingStopOrder(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  strategy: Strategy,
  side: "BUY" | "SELL",
  activationPrice: number,
  quantity: number,
  callbackRate: number,
  log: LogHandler,
  guard?: OrderGuardOptions,
  opts?: { priceTick: number; qtyStep: number }
): Promise<AsterOrder | undefined> {
  const type = "TRAILING_STOP_MARKET";
  if (isOperating(locks, strategy, type)) return;
  if (!enforceMarkPriceGuard(side, activationPrice, guard, log, "Ordem Trailing Stop")) return;
  const priceTick = opts?.priceTick ?? 0.1;
  const qtyStep = opts?.qtyStep ?? 0.001;
  const params: CreateOrderParams = {
    symbol,
    side,
    type,
    quantity: roundQtyDownToStep(quantity, qtyStep),
    reduceOnly: "true",
    activationPrice: roundDownToTick(activationPrice, priceTick),
    callbackRate,
    timeInForce: "GTC",
  };
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, strategy, type, side, log);
  lockOperating(locks, timers, pendings, strategy, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[getLockKey(strategy, type)] = String(order.orderId);
    log(
      "order",
      `[${strategy}] Colocando ordem trailing stop: ${side} activation=${params.activationPrice} callbackRate=${callbackRate}`
    );
    return order;
  } catch (err) {
    unlockOperating(locks, timers, pendings, strategy, type);
    if (isUnknownOrderError(err)) {
      log("order", "Ordem trailing stop já inválida, pulando");
      return undefined;
    }
    throw err;
  }
}

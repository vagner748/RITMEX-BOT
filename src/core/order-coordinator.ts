import type { ExchangeAdapter } from "../exchanges/adapter";
import type { AsterOrder, CreateOrderParams } from "../exchanges/types";
import { roundDownToTick, roundQtyDownToStep } from "../utils/math";
import { isUnknownOrderError } from "../utils/errors";
import { isOrderPriceAllowedByMark } from "../utils/strategy";

export type OrderLockMap = Record<string, boolean>;
export type OrderTimerMap = Record<string, ReturnType<typeof setTimeout> | null>;
export type OrderPendingMap = Record<string, string | null>;
export type LogHandler = (type: string, detail: string) => void;

type OrderGuardOptions = {
  markPrice?: number | null;
  expectedPrice?: number | null;
  maxPct?: number;
};

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

export function isOperating(locks: OrderLockMap, type: string): boolean {
  return Boolean(locks[type]);
}

export function lockOperating(
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  type: string,
  log: LogHandler,
  timeout = 3000
): void {
  locks[type] = true;
  if (timers[type]) {
    clearTimeout(timers[type]!);
  }
  timers[type] = setTimeout(() => {
    locks[type] = false;
    pendings[type] = null;
    log("info", `${type} operação desbloqueada automaticamente por timeout`);
  }, timeout);
}

export function unlockOperating(
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  type: string
): void {
  locks[type] = false;
  pendings[type] = null;
  if (timers[type]) {
    clearTimeout(timers[type]!);
  }
  timers[type] = null;
}

export async function deduplicateOrders(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  type: string,
  side: string,
  log: LogHandler
): Promise<void> {
  const sameTypeOrders = openOrders.filter((o) => o.type === type && o.side === side);
  if (sameTypeOrders.length <= 1) return;
  sameTypeOrders.sort((a, b) => {
    const ta = b.updateTime || b.time || 0;
    const tb = a.updateTime || a.time || 0;
    return ta - tb;
  });
  const toCancel = sameTypeOrders.slice(1);
  const orderIdList = toCancel.map((o) => o.orderId);
  if (!orderIdList.length) return;
  try {
    lockOperating(locks, timers, pendings, type, log);
    await adapter.cancelOrders({ symbol, orderIdList });
    log("order", `Cancelando ordens duplicadas do tipo ${type}: ${orderIdList.join(",")}`);
  } catch (err) {
    if (isUnknownOrderError(err)) {
      log("order", "Ordem não encontrada ao remover duplicatas, pulando exclusão");
    } else {
      log("error", `Falha ao cancelar ordem para remover duplicata: ${String(err)}`);
    }
  } finally {
    unlockOperating(locks, timers, pendings, type);
  }
}

export async function placeOrder(
  adapter: ExchangeAdapter,
  symbol: string,
  openOrders: AsterOrder[],
  locks: OrderLockMap,
  timers: OrderTimerMap,
  pendings: OrderPendingMap,
  side: "BUY" | "SELL",
  price: number,
  amount: number,
  log: LogHandler,
  reduceOnly = false,
  guard?: OrderGuardOptions,
  opts?: { priceTick: number; qtyStep: number }
): Promise<AsterOrder | undefined> {
  const type = "LIMIT";
  if (isOperating(locks, type)) return;
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
  };
  if (reduceOnly) params.reduceOnly = "true";
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, type, side, log);
  lockOperating(locks, timers, pendings, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[type] = String(order.orderId);
    log("order", `Colocando ordem limite: ${side} @ ${params.price} quantidade ${params.quantity} reduceOnly=${reduceOnly}`);
    return order;
  } catch (err) {
    unlockOperating(locks, timers, pendings, type);
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
  side: "BUY" | "SELL",
  amount: number,
  log: LogHandler,
  reduceOnly = false,
  guard?: OrderGuardOptions,
  opts?: { qtyStep: number }
): Promise<AsterOrder | undefined> {
  const type = "MARKET";
  if (isOperating(locks, type)) return;
  if (!enforceMarkPriceGuard(side, guard?.expectedPrice ?? null, guard, log, "Ordem a Mercado")) return;
  const qtyStep = opts?.qtyStep ?? 0.001;
  const params: CreateOrderParams = {
    symbol,
    side,
    type,
    quantity: roundQtyDownToStep(amount, qtyStep),
  };
  if (reduceOnly) params.reduceOnly = "true";
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, type, side, log);
  lockOperating(locks, timers, pendings, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[type] = String(order.orderId);
    log("order", `Ordem a mercado: ${side} quantidade ${params.quantity} reduceOnly=${reduceOnly}`);
    return order;
  } catch (err) {
    unlockOperating(locks, timers, pendings, type);
    if (isUnknownOrderError(err)) {
      log("order", "Falha na ordem a mercado, mas a ordem não existe mais, ignorando");
      return undefined;
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
  side: "BUY" | "SELL",
  stopPrice: number,
  quantity: number,
  lastPrice: number | null,
  log: LogHandler,
  guard?: OrderGuardOptions,
  opts?: { priceTick: number; qtyStep: number }
): Promise<AsterOrder | undefined> {
  const type = "STOP_MARKET";
  if (isOperating(locks, type)) return;
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
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, type, side, log);
  lockOperating(locks, timers, pendings, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[type] = String(order.orderId);
    log("stop", `Colocando ordem stop: ${side} STOP_MARKET @ ${params.stopPrice}`);
    return order;
  } catch (err) {
    unlockOperating(locks, timers, pendings, type);
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
  side: "BUY" | "SELL",
  activationPrice: number,
  quantity: number,
  callbackRate: number,
  log: LogHandler,
  guard?: OrderGuardOptions,
  opts?: { priceTick: number; qtyStep: number }
): Promise<AsterOrder | undefined> {
  const type = "TRAILING_STOP_MARKET";
  if (isOperating(locks, type)) return;
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
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, type, side, log);
  lockOperating(locks, timers, pendings, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[type] = String(order.orderId);
    log(
      "order",
      `Colocando ordem trailing stop: ${side} activation=${params.activationPrice} callbackRate=${callbackRate}`
    );
    return order;
  } catch (err) {
    unlockOperating(locks, timers, pendings, type);
    if (isUnknownOrderError(err)) {
      log("order", "Ordem trailing stop já inválida, pulando");
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
  side: "BUY" | "SELL",
  quantity: number,
  log: LogHandler,
  guard?: OrderGuardOptions,
  opts?: { qtyStep: number }
): Promise<void> {
  const type = "MARKET";
  if (isOperating(locks, type)) return;
  if (!enforceMarkPriceGuard(side, guard?.expectedPrice ?? null, guard, log, "Fechamento a Mercado")) return;
  const qtyStep = opts?.qtyStep ?? 0.001;
  const params: CreateOrderParams = {
    symbol,
    side,
    type,
    quantity: roundQtyDownToStep(quantity, qtyStep),
    reduceOnly: "true",
  };
  await deduplicateOrders(adapter, symbol, openOrders, locks, timers, pendings, type, side, log);
  lockOperating(locks, timers, pendings, type, log);
  try {
    const order = await adapter.createOrder(params);
    pendings[type] = String(order.orderId);
    log("close", `Fechamento a mercado: ${side}`);
  } catch (err) {
    unlockOperating(locks, timers, pendings, type);
    if (isUnknownOrderError(err)) {
      log("order", "Ordem não existe mais ao fechar a mercado");
      return;
    }
    throw err;
  }
}

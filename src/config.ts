export interface TradingConfig {
  symbol: string;
  tradeAmount: number;
  lossLimit: number;
  trailingProfit: number;
  trailingCallbackRate: number;
  profitLockTriggerUsd: number;
  profitLockOffsetUsd: number;
  pollIntervalMs: number;
  maxLogEntries: number;
  klineInterval: string;
  maxCloseSlippagePct: number;
  priceTick: number; // price tick size, e.g. 0.1 for BTCUSDT
  qtyStep: number;   // quantity step size, e.g. 0.001 BTC
  bollingerLength: number;
  bollingerStdMultiplier: number;
  minBollingerBandwidth: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  rsiExitLevel: number;
  smaPeriod: number;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value.toLowerCase() === 'true';
}

export const tradingConfig: TradingConfig = {
  symbol: process.env.TRADE_SYMBOL ?? "BTCUSDT",
  tradeAmount: parseNumber(process.env.TRADE_AMOUNT, 0.001),
  lossLimit: parseNumber(process.env.LOSS_LIMIT, 0.03),
  trailingProfit: parseNumber(process.env.TRAILING_PROFIT, 0.2),
  trailingCallbackRate: parseNumber(process.env.TRAILING_CALLBACK_RATE, 0.2),
  profitLockTriggerUsd: parseNumber(process.env.PROFIT_LOCK_TRIGGER_USD, 0.1),
  profitLockOffsetUsd: parseNumber(process.env.PROFIT_LOCK_OFFSET_USD, 0.05),
  pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 500),
  maxLogEntries: parseNumber(process.env.MAX_LOG_ENTRIES, 200),
  klineInterval: process.env.KLINE_INTERVAL ?? "1m",
  maxCloseSlippagePct: parseNumber(process.env.MAX_CLOSE_SLIPPAGE_PCT, 0.05),
  priceTick: parseNumber(process.env.PRICE_TICK, 0.1),
  qtyStep: parseNumber(process.env.QTY_STEP, 0.001),
  bollingerLength: parseNumber(process.env.BOLLINGER_LENGTH, 20),
  bollingerStdMultiplier: parseNumber(process.env.BOLLINGER_STD_MULTIPLIER, 2),
  minBollingerBandwidth: parseNumber(process.env.MIN_BOLLINGER_BANDWIDTH, 0.001),
  rsiPeriod: parseNumber(process.env.RSI_PERIOD, 14),
  rsiOversold: parseNumber(process.env.RSI_OVERSOLD, 25),
  rsiOverbought: parseNumber(process.env.RSI_OVERBOUGHT, 75),
  rsiExitLevel: parseNumber(process.env.RSI_EXIT_LEVEL, 50),
  smaPeriod: parseNumber(process.env.SMA_PERIOD, 30),
};

export interface MakerConfig {
  symbol: string;
  tradeAmount: number;
  lossLimit: number;
  priceChaseThreshold: number;
  bidOffset: number;
  askOffset: number;
  refreshIntervalMs: number;
  maxLogEntries: number;
  maxCloseSlippagePct: number;
  priceTick: number;
}

export const makerConfig: MakerConfig = {
  symbol: process.env.TRADE_SYMBOL ?? "BTCUSDT",
  tradeAmount: parseNumber(process.env.TRADE_AMOUNT, 0.001),
  lossLimit: parseNumber(process.env.MAKER_LOSS_LIMIT, parseNumber(process.env.LOSS_LIMIT, 0.03)),
  priceChaseThreshold: parseNumber(process.env.MAKER_PRICE_CHASE, 0.3),
  bidOffset: parseNumber(process.env.MAKER_BID_OFFSET, 0),
  askOffset: parseNumber(process.env.MAKER_ASK_OFFSET, 0),
  refreshIntervalMs: parseNumber(process.env.MAKER_REFRESH_INTERVAL_MS, 1500),
  maxLogEntries: parseNumber(process.env.MAKER_MAX_LOG_ENTRIES, 200),
  maxCloseSlippagePct: parseNumber(
    process.env.MAKER_MAX_CLOSE_SLIPPAGE_PCT ?? process.env.MAX_CLOSE_SLIPPAGE_PCT,
    0.05
  ),
  priceTick: parseNumber(process.env.MAKER_PRICE_TICK ?? process.env.PRICE_TICK, 0.1),
};

export interface GridConfig {
  enabled: boolean;
  symbol: string;
  numOrders: number;
  spacingPct: number;
  profitPct: number;
  stopLossPct: number;
  maxPositions: number;
  rebalanceIntervalMs: number;
  rsiPeriod: number;
  rsiTimeframe: string;
  centerCandles: number;
  orderSize: number;
  minSpreadPct: number;
  lossLimit: number;
}

export const gridConfig: GridConfig = {
  enabled: parseBoolean(process.env.GRID_ENABLED, true),
  symbol: process.env.TRADE_SYMBOL ?? "BTCUSDT",
  numOrders: parseNumber(process.env.GRID_NUM_ORDERS, 10),
  spacingPct: parseNumber(process.env.GRID_SPACING_PCT, 0.3),
  profitPct: parseNumber(process.env.GRID_PROFIT_PCT, 0.4),
  stopLossPct: parseNumber(process.env.GRID_STOP_LOSS, 1.0),
  maxPositions: parseNumber(process.env.GRID_MAX_POSITIONS, 3),
  rebalanceIntervalMs: parseNumber(process.env.GRID_REBALANCE_INTERVAL, 300000),
  rsiPeriod: parseNumber(process.env.GRID_RSI_PERIOD, 14),
  rsiTimeframe: process.env.GRID_RSI_TIMEFRAME ?? '15m',
  centerCandles: parseNumber(process.env.GRID_CENTER_CANDLES, 100),
  orderSize: parseNumber(process.env.GRID_ORDER_SIZE, 0.005),
  minSpreadPct: parseNumber(process.env.GRID_MIN_SPREAD, 0.1),
  lossLimit: parseNumber(process.env.LOSS_LIMIT, 0.03),
};

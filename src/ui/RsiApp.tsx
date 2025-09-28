import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { tradingConfig } from "../config";
import {
  createExchangeAdapter,
  getExchangeDisplayName,
  resolveExchangeId,
} from "../exchanges/create-adapter";
import { RsiEngine, type RsiEngineSnapshot } from "../strategy/rsi-engine";
import { formatNumber } from "../utils/format";
import { DataTable, type TableColumn } from "./components/DataTable";

const READY_MESSAGE = "Aguardando dados da exchange…";

interface RsiAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function RsiApp({ onExit }: RsiAppProps) {
  const [snapshot, setSnapshot] = useState<RsiEngineSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<RsiEngine | null>(null);
  const exchangeId = useMemo(() => resolveExchangeId(), []);
  const exchangeName = useMemo(() => getExchangeDisplayName(exchangeId), [exchangeId]);

  useInput(
    (input, key) => {
      if (key.escape) {
        engineRef.current?.stop();
        onExit();
      }
    },
    { isActive: inputSupported }
  );

  useEffect(() => {
    try {
      let adapter;
      if (exchangeId === "aster") {
        const apiKey = process.env.ASTER_API_KEY;
        const apiSecret = process.env.ASTER_API_SECRET;
        if (!apiKey || !apiSecret) {
          setError(new Error("Faltando variáveis de ambiente ASTER_API_KEY ou ASTER_API_SECRET"));
          return;
        }
        adapter = createExchangeAdapter({
          exchange: exchangeId,
          symbol: tradingConfig.symbol,
          aster: { apiKey, apiSecret },
        });
      } else {
        adapter = createExchangeAdapter({
          exchange: exchangeId,
          symbol: tradingConfig.symbol,
          grvt: { symbol: tradingConfig.symbol },
        });
      }
      const engine = new RsiEngine(tradingConfig, adapter);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: RsiEngineSnapshot) => {
        setSnapshot({ ...next, tradeLog: [...next.tradeLog] });
      };
      engine.on("update", handler);
      engine.start();
      return () => {
        engine.off("update", handler);
        engine.stop();
      };
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [exchangeId]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Falha ao iniciar: {error.message}</Text>
        <Text color="gray">Por favor, verifique suas variáveis de ambiente e conexão de rede.</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>Inicializando estratégia RSI…</Text>
      </Box>
    );
  }

  const { position, tradeLog, openOrders, trend, ready, lastPrice, sma30, rsi, sessionVolume } = snapshot;
  const hasPosition = Math.abs(position.positionAmt) > 1e-5;
  const lastLogs = tradeLog.slice(-5);
  const sortedOrders = [...openOrders].sort((a, b) => (Number(b.updateTime ?? 0) - Number(a.updateTime ?? 0)) || Number(b.orderId) - Number(a.orderId));
  const orderRows = sortedOrders.slice(0, 8).map((order) => ({
    id: order.orderId,
    side: order.side,
    type: order.type,
    price: order.price,
    qty: order.origQty,
    filled: order.executedQty,
    status: order.status,
  }));
  const orderColumns: TableColumn[] = [
    { key: "id", header: "ID", align: "right", minWidth: 6 },
    { key: "side", header: "Side", minWidth: 4 },
    { key: "type", header: "Type", minWidth: 10 },
    { key: "price", header: "Price", align: "right", minWidth: 10 },
    { key: "qty", header: "Qty", align: "right", minWidth: 8 },
    { key: "filled", header: "Filled", align: "right", minWidth: 8 },
    { key: "status", header: "Status", minWidth: 10 },
  ];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">RSI Strategy Dashboard</Text>
        <Text>
          Exchange: {exchangeName} ｜ Par: {snapshot.symbol} ｜ Preço Recente: {formatNumber(lastPrice, 2)} ｜ SMA30: {formatNumber(sma30, 2)} ｜ RSI: {formatNumber(rsi, 2)} ｜ Tendência: {trend}
        </Text>
        <Text color="gray">Status: {ready ? "Executando em tempo real" : READY_MESSAGE} ｜ Pressione Esc para voltar à seleção de estratégia</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">Posição</Text>
          {hasPosition ? (
            <>
              <Text>
                Direção: {position.positionAmt > 0 ? "Comprado" : "Vendido"} ｜ Quantidade: {formatNumber(Math.abs(position.positionAmt), 4)} ｜ Preço de Entrada: {formatNumber(position.entryPrice, 2)}
              </Text>
              <Text>
                P&L Flutuante: {formatNumber(snapshot.pnl, 4)} USDT ｜ P&L Não Realizado da Conta: {formatNumber(snapshot.unrealized, 4)} USDT
              </Text>
            </>
          ) : (
            <Text color="gray">Sem posição atual</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">Desempenho</Text>
          <Text>
            Total de Trades: {snapshot.totalTrades} ｜ Lucro Total: {formatNumber(snapshot.totalProfit, 4)} USDT
          </Text>
          <Text>
            Volume da Sessão: {formatNumber(sessionVolume, 2)} USDT
          </Text>
          {snapshot.lastOpenSignal.side ? (
            <Text color="gray">
              Último Sinal de Abertura: {snapshot.lastOpenSignal.side} @ {formatNumber(snapshot.lastOpenSignal.price, 2)}
            </Text>
          ) : null}
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">Ordens Abertas Atuais</Text>
        {orderRows.length > 0 ? (
          <DataTable columns={orderColumns} rows={orderRows} />
        ) : (
          <Text color="gray">Nenhuma ordem aberta</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">Trades e Eventos Recentes</Text>
        {lastLogs.length > 0 ? (
          lastLogs.map((item, index) => (
            <Text key={`${item.time}-${index}`}>
              [{item.time}] [{item.type}] {item.detail}
            </Text>
          ))
        ) : (
          <Text color="gray">Nenhum log</Text>
        )}
      </Box>
    </Box>
  );
}

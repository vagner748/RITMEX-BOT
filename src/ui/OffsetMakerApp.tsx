import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { makerConfig } from "../config";
import {
  createExchangeAdapter,
  getExchangeDisplayName,
  resolveExchangeId,
} from "../exchanges/create-adapter";
import { OffsetMakerEngine, type OffsetMakerEngineSnapshot } from "../strategy/offset-maker-engine";
import { DataTable, type TableColumn } from "./components/DataTable";
import { formatNumber } from "../utils/format";

interface OffsetMakerAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function OffsetMakerApp({ onExit }: OffsetMakerAppProps) {
  const [snapshot, setSnapshot] = useState<OffsetMakerEngineSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<OffsetMakerEngine | null>(null);
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
          symbol: makerConfig.symbol,
          aster: { apiKey, apiSecret },
        });
      } else {
        adapter = createExchangeAdapter({
          exchange: exchangeId,
          symbol: makerConfig.symbol,
          grvt: { symbol: makerConfig.symbol },
        });
      }
      const engine = new OffsetMakerEngine(makerConfig, adapter);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: OffsetMakerEngineSnapshot) => {
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
        <Text>Inicializando estratégia de market making com deslocamento…</Text>
      </Box>
    );
  }

  const topBid = snapshot.topBid;
  const topAsk = snapshot.topAsk;
  const spreadDisplay = snapshot.spread != null ? `${snapshot.spread.toFixed(4)} USDT` : "-";
  const hasPosition = Math.abs(snapshot.position.positionAmt) > 1e-5;
  const sortedOrders = [...snapshot.openOrders].sort((a, b) =>
    (Number(b.updateTime ?? 0) - Number(a.updateTime ?? 0)) || Number(b.orderId) - Number(a.orderId)
  );
  const openOrderRows = sortedOrders.slice(0, 8).map((order) => ({
    id: order.orderId,
    side: order.side,
    price: order.price,
    qty: order.origQty,
    filled: order.executedQty,
    reduceOnly: order.reduceOnly ? "yes" : "no",
    status: order.status,
  }));
  const openOrderColumns: TableColumn[] = [
    { key: "id", header: "ID", align: "right", minWidth: 6 },
    { key: "side", header: "Side", minWidth: 4 },
    { key: "price", header: "Price", align: "right", minWidth: 10 },
    { key: "qty", header: "Qty", align: "right", minWidth: 8 },
    { key: "filled", header: "Filled", align: "right", minWidth: 8 },
    { key: "reduceOnly", header: "RO", minWidth: 4 },
    { key: "status", header: "Status", minWidth: 10 },
  ];

  const desiredRows = snapshot.desiredOrders.map((order, index) => ({
    index: index + 1,
    side: order.side,
    price: order.price,
    amount: order.amount,
    reduceOnly: order.reduceOnly ? "yes" : "no",
  }));
  const desiredColumns: TableColumn[] = [
    { key: "index", header: "#", align: "right", minWidth: 2 },
    { key: "side", header: "Side", minWidth: 4 },
    { key: "price", header: "Price", align: "right", minWidth: 10 },
    { key: "amount", header: "Qty", align: "right", minWidth: 8 },
    { key: "reduceOnly", header: "RO", minWidth: 4 },
  ];

  const lastLogs = snapshot.tradeLog.slice(-5);
  const imbalanceLabel = snapshot.depthImbalance === "balanced"
    ? "Equilibrado"
    : snapshot.depthImbalance === "buy_dominant"
    ? "Compra dominante"
    : "Venda dominante";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">Offset Maker Strategy Dashboard</Text>
        <Text>
          Exchange: {exchangeName} ｜ Par: {snapshot.symbol} ｜ Preço de Compra: {formatNumber(topBid, 2)} ｜ Preço de Venda: {formatNumber(topAsk, 2)} ｜ Spread: {spreadDisplay}
        </Text>
        <Text>
          Soma de Profundidade de Compra (10 níveis): {formatNumber(snapshot.buyDepthSum10, 4)} ｜ Soma de Profundidade de Venda (10 níveis): {formatNumber(snapshot.sellDepthSum10, 4)} ｜ Status: {imbalanceLabel}
        </Text>
        <Text color="gray">
          Estratégia de Ordem Atual: COMPRA {snapshot.skipBuySide ? "Pausada" : "Ativada"} ｜ VENDA {snapshot.skipSellSide ? "Pausada" : "Ativada"} ｜ Pressione Esc para voltar à seleção de estratégia
        </Text>
        <Text color="gray">Status: {snapshot.ready ? "Executando em tempo real" : "Aguardando dados de mercado"}</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">Posição</Text>
          {hasPosition ? (
            <>
              <Text>
                Direção: {snapshot.position.positionAmt > 0 ? "Comprado" : "Vendido"} ｜ Quantidade: {formatNumber(Math.abs(snapshot.position.positionAmt), 4)} ｜ Preço de Entrada: {formatNumber(snapshot.position.entryPrice, 2)}
              </Text>
              <Text>
                P&L Flutuante: {formatNumber(snapshot.pnl, 4)} USDT ｜ P&L Não Realizado da Conta: {formatNumber(snapshot.accountUnrealized, 4)} USDT
              </Text>
            </>
          ) : (
            <Text color="gray">Sem posição atual</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">Ordens Desejadas</Text>
          {desiredRows.length > 0 ? (
            <DataTable columns={desiredColumns} rows={desiredRows} />
          ) : (
            <Text color="gray">Nenhuma ordem desejada</Text>
          )}
          <Text>
            Volume da Sessão: {formatNumber(snapshot.sessionVolume, 2)} USDT
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">Ordens Abertas Atuais</Text>
        {openOrderRows.length > 0 ? (
          <DataTable columns={openOrderColumns} rows={openOrderRows} />
        ) : (
          <Text color="gray">Nenhuma ordem aberta</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">Eventos Recentes</Text>
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

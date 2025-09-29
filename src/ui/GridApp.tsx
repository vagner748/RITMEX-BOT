import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { gridConfig } from "../config";
import { createExchangeAdapter, getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import { GridEngine, type GridEngineSnapshot } from "../core/grid-engine";
import { formatNumber } from "../utils/format";
import { DataTable, type TableColumn } from "./components/DataTable";

const READY_MESSAGE = "Aguardando dados da exchange…";

interface GridAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function GridApp({ onExit }: GridAppProps) {
  const [snapshot, setSnapshot] = useState<GridEngineSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<GridEngine | null>(null);
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
      const adapter = createExchangeAdapter({ exchange: exchangeId, symbol: gridConfig.symbol });
      const engine = new GridEngine(adapter);
      engineRef.current = engine;

      const handler = (next: GridEngineSnapshot) => {
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
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>Inicializando estratégia Grid...</Text>
      </Box>
    );
  }

  const { ready, lastPrice, rsi, gridLevels, openPositions, activeGridOrders, tradeLog } = snapshot;

  const buyLevels = gridLevels.filter(l => l.side === 'buy').sort((a, b) => b.price - a.price);
  const sellLevels = gridLevels.filter(l => l.side === 'sell').sort((a, b) => a.price - b.price);

  const gridColumns: TableColumn[] = [
    { key: "buyPrice", header: "BUY", align: "right", minWidth: 12 },
    { key: "sellPrice", header: "SELL", align: "right", minWidth: 12 },
  ];

  const gridRows = Array.from({ length: Math.max(buyLevels.length, sellLevels.length) }).map((_, i) => ({
    buyPrice: buyLevels[i] ? formatNumber(buyLevels[i].price, 2) : '-',
    sellPrice: sellLevels[i] ? formatNumber(sellLevels[i].price, 2) : '-',
  }));

  const lastLogs = tradeLog.slice(-5);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">Grid Trading Dashboard</Text>
        <Text>
          Exchange: {exchangeName} ｜ Par: {snapshot.symbol} ｜ Preço: {formatNumber(lastPrice, 2)} ｜ RSI: {formatNumber(rsi, 2)}
        </Text>
        <Text color="gray">Status: {ready ? "Executando" : READY_MESSAGE} ｜ Pressione Esc para sair</Text>
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={4}>
            <Text color="yellow">Grid Levels (Center: {formatNumber(snapshot.centerPrice, 2)})</Text>
            <DataTable columns={gridColumns} rows={gridRows} />
        </Box>
        <Box flexDirection="column">
            <Text color="yellow">Posições Abertas ({openPositions.length})</Text>
            {openPositions.length > 0 ? (
                <Text>Not implemented</Text>
            ) : (
                <Text color="gray">Nenhuma posição aberta</Text>
            )}

            <Box marginTop={1}>
                <Text color="yellow">Ordens Ativas no Grid ({activeGridOrders.length})</Text>
                {activeGridOrders.length > 0 ? (
                    activeGridOrders.map(o => (
                        <Text key={o.orderId}>{o.side} @ {formatNumber(parseFloat(o.price), 2)}</Text>
                    ))
                ) : (
                    <Text color="gray">Nenhuma ordem ativa</Text>
                )}
            </Box>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">Logs Recentes</Text>
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

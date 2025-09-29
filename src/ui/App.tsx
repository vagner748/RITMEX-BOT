import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TrendApp } from "./TrendApp";
import { MakerApp } from "./MakerApp";
import { OffsetMakerApp } from "./OffsetMakerApp";
import { RsiApp } from "./RsiApp";
import { SmaRsiApp } from "./SmaRsiApp";
import { GridApp } from "./GridApp"; // Import the new GridApp
import { decryptCopyright, verifyCopyrightIntegrity } from "../utils/copyright";

interface StrategyOption {
  id: "trend" | "maker" | "offset-maker" | "rsi" | "sma-rsi" | "grid"; // Add 'grid' to type
  label: string;
  description: string;
  component: React.ComponentType<{ onExit: () => void }>;
}

const STRATEGIES: StrategyOption[] = [
  {
    id: "trend",
    label: "Estratégia de Acompanhamento de Tendência (SMA30)",
    description: "Monitora sinais de média móvel, entra e sai do mercado automaticamente e mantém stop-loss/take-profit",
    component: TrendApp,
  },
  {
    id: "maker",
    label: "Estratégia de Market Making",
    description: "Coloca ordens de ambos os lados para fornecer liquidez, com ajuste automático de preço e controle de risco com stop-loss",
    component: MakerApp,
  },
  {
    id: "offset-maker",
    label: "Estratégia de Market Making com Deslocamento",
    description: "Desloca ordens automaticamente com base na profundidade do book e recua em desequilíbrios extremos",
    component: OffsetMakerApp,
  },
  {
    id: "rsi",
    label: "Estratégia RSI",
    description: "Estratégia baseada no Índice de Força Relativa (RSI)",
    component: RsiApp,
  },
  {
    id: "sma-rsi",
    label: "Estratégia SMA30 + RSI",
    description: "Combina Média Móvel Simples (SMA30) e Índice de Força Relativa (RSI) para pontos de entrada e saída",
    component: SmaRsiApp,
  },
  {
    id: "grid",
    label: "Estratégia de Grid Trading (NOVO)",
    description: "Cria uma grade de ordens de compra e venda para lucrar com mercados laterais, usando RSI como filtro.",
    component: GridApp,
  },
];

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function App() {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<StrategyOption | null>(null);
  const bannerText = useMemo(() => decryptCopyright(), []);
  const integrityOk = useMemo(() => verifyCopyrightIntegrity(), []);

  useInput(
    (input, key) => {
      if (selected) return;
      if (key.upArrow) {
        setCursor((prev) => (prev - 1 + STRATEGIES.length) % STRATEGIES.length);
      } else if (key.downArrow) {
        setCursor((prev) => (prev + 1) % STRATEGIES.length);
      } else if (key.return) {
        const strategy = STRATEGIES[cursor];
        if (strategy) {
          setSelected(strategy);
        }
      }
    },
    { isActive: inputSupported && !selected }
  );

  if (selected) {
    const Selected = selected.component;
    return <Selected onExit={() => setSelected(null)} />;
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="gray">{bannerText}</Text>
      {integrityOk ? null : (
        <Text color="red">Aviso: A verificação de direitos autorais falhou, a versão atual pode ter sido adulterada.</Text>
      )}
      <Box height={1}>
        <Text color="gray">────────────────────────────────────────────────────</Text>
      </Box>
      <Text color="cyanBright">Por favor, selecione a estratégia que deseja executar</Text>
      <Text color="gray">Use ↑/↓ para selecionar, Enter para iniciar, Ctrl+C para sair.</Text>
      <Box flexDirection="column" marginTop={1}>
        {STRATEGIES.map((strategy, index) => {
          const active = index === cursor;
          return (
            <Box key={strategy.id} flexDirection="column" marginBottom={1}>
              <Text color={active ? "greenBright" : undefined}>
                {active ? "➤" : "  "} {strategy.label}
              </Text>
              <Text color="gray">    {strategy.description}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
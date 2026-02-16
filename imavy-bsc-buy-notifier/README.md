# imavy-bsc-buy-notifier

Servico Node.js para rodar 24/7 em VPS, monitorando **somente BUY** na BSC via eventos `Swap` de PAIRs PancakeSwap V2 e enviando alerta para o grupo WhatsApp **TESTE IMAVY** usando **WhatsApp Web + Baileys**.

## Regras implementadas

- Escuta apenas os PAIRs fixos:
  - NIX pair: `0x7f01f344b1950a3C5EA3B9dB7017f93aB0c8f88E`
  - SNAP pair: `0x7646C457a2C4d260f678F3126Fa41e20BFdD1F95`
- WBNB fixo: `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`
- Startup valida `token0()` e `token1()` para confirmar lado WBNB.
- Envia alerta apenas quando:
  - Detecta BUY valido
  - USD > 5
  - Fora de cooldown (8s por token)
  - Nao suspeito de MEV/arbitragem (`Swap logs` da tx <= 3 quando filtro habilitado)
- Nao envia:
  - SELL
  - BUY <= $5
  - Duplicatas (`txHash:logIndex` com TTL 24h)
  - TX com multiplos swaps suspeitos (>3)
- WhatsApp:
  - Nao usa Cloud API
  - Sessao persistida em disco
  - Envio somente para grupo `TESTE IMAVY` (`@g.us`)
  - Retry de envio (3 tentativas com backoff)

## Estrutura

```txt
src/
  config/
  bsc/listener/
  bsc/buyDetector/
  filters/dedup/
  filters/cooldown/
  filters/mev/
  pricing/bnbUsd/
  whatsapp/client/
  main/
```

## Requisitos

- Node.js 20+
- Conta WhatsApp conectada no WhatsApp Web
- Conta presente no grupo `TESTE IMAVY`
- RPC BSC WebSocket e HTTP

## Configuracao

1. Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

2. Ajuste no `.env`:

- `BSC_WS_URL`
- `BSC_HTTP_URL`
- `WA_GROUP_NAME` (default `TESTE IMAVY`)
- filtros e tempos (se quiser)

## Execucao local

```bash
npm install
npm start
```

No primeiro start, escaneie o QR code no terminal.  
A sessao fica salva em `./wa-session`.

## Execucao com Docker (24/7)

```bash
docker compose up -d --build
```

Para logs:

```bash
docker compose logs -f notifier
```

## Confiabilidade

- Reconexao WS automatica com backoff exponencial (2s -> 5s -> 10s -> ... -> 60s)
- Heartbeat a cada 30s com `getBlockNumber()`
- Fallback HTTP polling quando WS cair:
  - `getLogs` por batches de 200 blocos
  - retry em rate limit

## Formato da mensagem

```txt
🟢 NOVA COMPRA | <SYMBOL>

💰 USD: $X.XX
🪙 Tokens: Y
👤 Wallet: 0x12...abcd
🔗 Tx: https://bscscan.com/tx/<hash>
📊 Chart: https://dexscreener.com/bsc/<pair>
🌐 BSC
```

## Observacoes de seguranca

- Este servico **nao envia mensagens para privados**.
- Se o grupo `TESTE IMAVY` nao existir na conta conectada, o servico nao sobe pronto para envio.
- Para reduzir falsos positivos de bot/arbitragem, mantenha `ENABLE_MEV_FILTER=true`.

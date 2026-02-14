# Ranking Dashboard (Texto)

Dashboard isolado para visualizar ranking de participantes por mensagens de texto, sem alterar o dashboard principal existente.

## Executar

```bash
cd "c:\Users\55699\Downloads\iMavy_patched_v3_watch\Bot iMavy 3"
node ranking-dashboard/server.cjs
```

## Acessar

- Frontend: `http://localhost:3010`
- Healthcheck: `http://localhost:3010/api/health`
- API ranking: `POST http://localhost:3010/api/ranking-texto`

## Payload da API

```json
{
  "interacoes": [
    { "nome": "Joao", "data": "2026-02-01" },
    { "nome": "Maria", "data": "2026-02-01" }
  ],
  "dataInicio": "2026-02-01",
  "dataFim": "2026-02-14"
}
```

# Ranking Dashboard (Texto)

Dashboard isolado para visualizar ranking de participantes por mensagens de texto.

## Executar

```bash
cd "c:\Users\55699\Downloads\iMavy_patched_v3_watch\Bot iMavy 3"
node ranking-dashboard/server.cjs
```

## Acessar

- Frontend principal: `http://localhost:3010`
- Frontend multi-cliente: `http://localhost:3010/multitenant.html`
- Healthcheck: `http://localhost:3010/api/health`
- API ranking: `POST http://localhost:3010/api/ranking-texto`
- API grupos (Supabase): `GET http://localhost:3010/api/grupos-texto`
- API interacoes (Supabase): `GET http://localhost:3010/api/interacoes-texto?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD`
- API inteligencia (consulta): `GET http://localhost:3010/api/dashboard/intel-events?limit=20`
- API inteligencia (ingestao webhook): `POST http://localhost:3010/api/dashboard/intel-events`

## Modo Manual (JSON)

```json
{
  "interacoes": [
    { "nome": "Joao", "data": "2026-02-01", "grupo": "Vendas" },
    { "nome": "Maria", "data": "2026-02-01", "grupo": "Vendas" }
  ],
  "dataInicio": "2026-02-01",
  "dataFim": "2026-02-14",
  "grupoSelecionado": "Vendas"
}
```

## Modo Realtime (Supabase)

0. Configure variaveis de ambiente:
   - `IMAVY_SUPABASE_URL`
   - `IMAVY_SUPABASE_ANON_KEY` (frontend/dashboard)
   - `IMAVY_SUPABASE_SERVICE_KEY` (backend/bot, opcional quando usar apenas anon)
1. Execute o SQL: `ranking-dashboard/SUPABASE_REALTIME_SETUP.sql`.
2. O bot publica mensagens de texto na tabela `interacoes_texto`.
3. No frontend, clique em **Conectar tempo real**.
4. O dashboard passa a recalcular automaticamente ao receber `INSERT` no Supabase Realtime.

Payload para ranking via Supabase:

```json
{
  "dataInicio": "2026-02-01",
  "dataFim": "2026-02-14",
  "grupoSelecionado": "Vendas",
  "usarSupabase": true
}
```

## Multi-Cliente (SaaS)

### Setup SQL

Execute no Supabase:
- `ranking-dashboard/SUPABASE_MULTITENANT_SETUP.sql`

### Endpoints de autentica??o

- `POST /api/auth/register`
- `POST /api/auth/login`

JWT payload:

```json
{
  "clienteId": "...",
  "plano": "free|pro|enterprise",
  "exp": 0
}
```

### Endpoints de grupos (protegidos)

- `POST /api/grupos`
- `GET /api/grupos`
- `PUT /api/grupos/:id`
- `DELETE /api/grupos/:id`

### Dashboard por cliente (protegido)

- `GET /api/dashboard/ranking?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&grupoId=opcional`
- `GET /api/dashboard/intel-events?limit=20&type=SOCIAL_SPIKE|TOKEN_DOMINANCE|SOCIAL_ONCHAIN_CONFIRM`
- `POST /api/dashboard/intel-events` (webhook do bot, sem JWT; pode usar segredo)

### Intelligence Mode (bot -> dashboard)

No bot (`.env`):

- `DASHBOARD_WEBHOOK_URL=http://localhost:3010/api/dashboard/intel-events`
- `INTEL_WEBHOOK_SECRET=seu-segredo-forte` (opcional, recomendado)

No dashboard (`.env`/ambiente):

- `INTEL_WEBHOOK_SECRET=seu-segredo-forte` (mesmo valor do bot)

### Sync Bidirecional (dashboard -> bot)

No bot (`.env`):

- `DASHBOARD_SYNC_SECRET=seu-segredo-forte`

No dashboard (`.env`/ambiente):

- `BOT_SYNC_WEBHOOK_URL=http://SEU_BOT:3000/dashboard-sync`
- `DASHBOARD_SYNC_SECRET=seu-segredo-forte` (mesmo valor do bot)
- `BOT_SYNC_TIMEOUT_MS=5000` (opcional)

Com isso, alteracoes em grupos e politicas de acesso no dashboard disparam webhook imediato para o bot atualizar cache/config em tempo real.

### Ingestao do bot para multi-cliente

- O bot segue escrevendo em `interacoes_texto` (realtime global) sem impacto.
- Para escrever tambem em `interacoes_cliente` sem erro de FK, configure:
  - `IMAVY_MULTITENANT_WRITE_ENABLED=true`
  - `IMAVY_GROUP_CLIENTE_MAP` com JSON `grupoId -> clienteId`
- Exemplo:
  - `{"123456789@g.us":"uuid-cliente-a","987654321@g.us":{"clienteId":"uuid-cliente-b","nome":"Forex VIP"}}`

### Regras de plano

- Free: 1 grupo e 1000 intera??es/m?s
- Pro: at? 5 grupos
- Enterprise: ilimitado

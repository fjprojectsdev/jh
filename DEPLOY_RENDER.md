# 🚀 Deploy no Render

## Passo 1: Criar conta no Render
1. Acesse: https://render.com
2. Clique em "Get Started"
3. Faça login com GitHub

## Passo 2: Criar Web Service
1. No dashboard, clique em "New +"
2. Selecione "Web Service"
3. Conecte seu repositório GitHub: `fjprojectsdev/jh`
4. Configure:
   - **Name**: `imavy-bot`
   - **Region**: Oregon (US West)
   - **Branch**: `main`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Instance Type**: Free

## Passo 3: Configurar Variáveis de Ambiente
Clique em "Environment" e adicione as mesmas variáveis do seu .env local:

- `GROQ_API_KEY` - Sua chave da API Groq
- `AUTHORIZED_IDS` - IDs dos admins
- `DEV_IDS` - IDs dos desenvolvedores
- `DDD_PADRAO` - 64
- `COMMAND_COOLDOWN` - 3
- `GRUPO_HORARIO_ABERTURA` - 07:00
- `GRUPO_HORARIO_FECHAMENTO` - 00:00
- `NODE_ENV` - production
- `PORT` - 3000

## Passo 4: Deploy
1. Clique em "Create Web Service"
2. Aguarde o build (3-5 minutos)
3. Quando aparecer "Live", acesse a URL
4. Adicione `/qr` na URL para ver o QR Code
5. Escaneie com WhatsApp

## Passo 5: Manter Ativo
Render desliga apps gratuitos após 15min de inatividade.

Use UptimeRobot (gratuito):
1. Acesse: https://uptimerobot.com
2. Add New Monitor
3. URL: `https://imavy-bot.onrender.com`
4. Interval: 5 minutes

Pronto! Bot online 24/7 🎉

## 📱 Acessar QR Code
```
https://imavy-bot.onrender.com/qr
```

## 🔍 Ver Logs
No dashboard do Render, clique em "Logs"

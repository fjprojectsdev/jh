# 🚀 Deploy do Dashboard (Railway)

Este dashboard é um **serviço único** que entrega frontend + API pelo mesmo servidor Express.

## ✅ Passos no Railway

1. Acesse: https://railway.app
2. New Project → Deploy from GitHub
3. Selecione o repositório
4. Configure as variáveis de ambiente:
   - `JWT_SECRET` = sua_chave_secreta
   - `ADMIN_PASSWORD` = uma_senha_forte
   - `PORT` = 3000
5. Deploy automático

## 🔧 Comandos usados pelo Railway

- **Build:** `npm install`
- **Start:** `node server.js`

## 🔗 Acesso

Após o deploy, acesse a URL gerada pelo Railway e faça login com a senha configurada em `ADMIN_PASSWORD`.

## ✅ Checklist rápido

- [ ] Variáveis configuradas no Railway
- [ ] Deploy concluído sem erro
- [ ] Login funcionando
- [ ] Rotas API respondendo

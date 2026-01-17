# iMavyBot Dashboard

Dashboard web unificado (frontend + API) para gerenciamento do iMavyBot.

## 🚀 Funcionalidades

- ✅ Autenticação JWT segura
- ✅ Gerenciamento de palavras banidas
- ✅ Controle de grupos permitidos
- ✅ Visualização de administradores
- ✅ Logs recentes
- ✅ Estatísticas gerais
- ✅ Interface responsiva

## 📦 Instalação

```bash
cd dashboard
npm install
```

## ⚙️ Configuração

Configure as variáveis de ambiente no arquivo `.env` na raiz do projeto ou no painel do Railway:

```env
PORT=3000
JWT_SECRET=sua_chave_secreta_aqui
ADMIN_PASSWORD=defina_uma_senha_forte
```

> ⚠️ `JWT_SECRET` e `ADMIN_PASSWORD` são obrigatórios. O servidor não inicia sem essas variáveis.

## 🎯 Como Usar

1. Inicie o servidor:
```bash
npm start
```

2. Acesse no navegador:
```
http://localhost:3000
```

3. Faça login com a senha configurada em `ADMIN_PASSWORD`.

## 🔒 Segurança

- Autenticação JWT com expiração de 24h
- Tokens armazenados localmente
- Todas as rotas protegidas por middleware
- Logs de todas as ações administrativas

## 🛠️ Tecnologias

- **Backend**: Express.js, JWT, File System
- **Frontend**: HTML5, CSS3, JavaScript (Vanilla)

## 📱 Responsivo

Interface totalmente responsiva, funciona em desktop e mobile.

## 🔄 API Endpoints

### Autenticação
- `POST /api/login` - Login

### Estatísticas
- `GET /api/stats` - Estatísticas gerais

### Palavras Banidas
- `GET /api/banned-words` - Lista palavras
- `POST /api/banned-words` - Adiciona palavra
- `DELETE /api/banned-words/:word` - Remove palavra

### Grupos
- `GET /api/allowed-groups` - Lista grupos
- `POST /api/allowed-groups` - Adiciona grupo
- `DELETE /api/allowed-groups/:name` - Remove grupo

### Administradores
- `GET /api/admins` - Lista admins

### Logs
- `GET /api/logs` - Logs recentes

### Leads
- `GET /api/leads` - Leads recentes

## 📄 Licença

MIT

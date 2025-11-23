# iMavyAgent - Bot WhatsApp

Bot de moderação e automação para grupos do WhatsApp com dashboard web moderno.

## 🚀 Funcionalidades

### Bot
- ✅ Anti-spam com detecção inteligente de variações
- ✅ Sistema de strikes (3 strikes = expulsão)
- ✅ Lembretes automáticos com persistência
- ✅ Boas-vindas automáticas
- ✅ Abertura/fechamento automático de grupos
- ✅ Comandos administrativos
- ✅ Backup automático diário
- ✅ Rate limiting

### Dashboard Web
- ✅ Interface moderna e responsiva
- ✅ Gerenciamento de palavras banidas
- ✅ Controle de grupos permitidos
- ✅ Visualização de administradores
- ✅ Logs em tempo real
- ✅ Estatísticas do bot
- ✅ Autenticação JWT segura

## 📦 Instalação

### Bot WhatsApp
```bash
npm install
cp .env.example .env
# Configure o .env
node index.js
```

### Dashboard Web
```bash
cd dashboard
npm install
npm start
```

Ou use o atalho:
```bash
INICIAR_DASHBOARD.bat
```

Acesse: http://localhost:3000
Senha padrão: FJMR2025

## Comandos

### Administrativos
- `/fechar` - Fecha o grupo
- `/abrir` - Abre o grupo
- `/fixar [mensagem]` - Fixa mensagem
- `/banir @membro` - Bane membro
- `/addtermo [palavra]` - Adiciona palavra proibida
- `/removertermo [palavra]` - Remove palavra proibida
- `/listartermos` - Lista palavras proibidas
- `/lembrete + mensagem 1h 24h` - Cria lembrete
- `/stoplembrete` - Para lembrete
- `/stats` - Estatísticas do bot

### Gerenciamento
- `/adicionargrupo [nome]` - Adiciona grupo permitido
- `/removergrupo [nome]` - Remove grupo permitido
- `/listargrupos` - Lista grupos permitidos
- `/adicionaradmin @usuario` - Adiciona admin
- `/removeradmin @usuario` - Remove admin
- `/listaradmins` - Lista admins

### Informação
- `/regras` - Mostra regras do grupo
- `/status` - Status do grupo
- `/comandos` - Lista todos os comandos

## 📁 Estrutura de Arquivos

```
├── dashboard/         # Dashboard web
│   ├── public/       # Frontend (HTML, CSS, JS)
│   ├── server.js     # Backend API
│   └── README.md     # Documentação do dashboard
├── functions/         # Módulos do bot
├── backups/          # Backups automáticos
├── strikes.json      # Strikes dos usuários
├── lembretes.json    # Lembretes ativos
├── banned_words.json # Palavras proibidas
├── allowed_groups.json # Grupos permitidos
├── admins.json       # Administradores
└── bot.log          # Logs do sistema
```

## ⚙️ Configuração

Edite o arquivo `.env`:

```env
# Bot
GRUPO_HORARIO_ABERTURA=07:00
GRUPO_HORARIO_FECHAMENTO=00:00
DDD_PADRAO=64
COMMAND_COOLDOWN=3

# Dashboard
PORT=3000
JWT_SECRET=sua_chave_secreta_aqui
ADMIN_PASSWORD=FJMR2025

# APIs (opcional)
GROQ_API_KEY=your-groq-api-key
OPENROUTER_API_KEY=your-openrouter-api-key
```

## Backup

Backups automáticos diários às 3h da manhã.
Mantém backups dos últimos 7 dias.

## Logs

Logs estruturados salvos em `bot.log`.

## 🎨 Dashboard

O dashboard oferece uma interface visual para:
- Monitorar estatísticas em tempo real
- Gerenciar palavras banidas
- Controlar grupos permitidos
- Visualizar logs de atividades
- Administrar configurações

Veja mais detalhes em [dashboard/README.md](dashboard/README.md)

## 🔒 Segurança

- Autenticação JWT com expiração de 24h
- Proteção de rotas com middleware
- Logs de todas as ações administrativas
- Variáveis de ambiente para credenciais

## 🌐 Deploy

O projeto está pronto para deploy em:
- Railway
- Heroku
- VPS (Linux/Windows)
- Docker

## 📝 Suporte

Para problemas ou sugestões, abra uma issue no GitHub.

# 🔒 CHECKLIST DE SEGURANÇA - ANTES DE FAZER UPLOAD

## ⚠️ CRÍTICO - VERIFIQUE ANTES DE SUBIR PARA A NUVEM!

### 1. ✅ Arquivos que JÁ estão no .gitignore:
- `auth_info/` - Credenciais do WhatsApp
- `.env` - Variáveis de ambiente
- `bot_memory.json` - Memória do bot
- Arquivos de debug

### 2. ⚠️ Arquivos que devem ser removidos ou não commitados:

#### ❌ NUNCA faça commit destes arquivos:
- `allowed_groups.json` - Contém lista de grupos
- `allowed_users.json` - Contém IDs de usuários
- `blacklist.json` - Pode conter dados sensíveis

#### ✅ Use os arquivos de exemplo:
- `allowed_groups.example.json`
- `allowed_users.example.json`
- `blacklist.example.json`

### 3. 🔑 Credenciais removidas do código:

#### ✅ `functions/adminCommands.js`
- IDs de administradores agora vêm de `AUTHORIZED_IDS` no `.env`

#### ✅ `functions/scheduler.js`
- ID do grupo agora vem de `SCHEDULER_TARGET_GROUP` no `.env`

### 4. 📋 Checklist antes de fazer commit:

- [ ] Verifique se `.env` não está sendo commitado (já está no .gitignore)
- [ ] Verifique se `auth_info/` não está sendo commitado (já está no .gitignore)
- [ ] Remova ou ignore `allowed_groups.json` se contiver dados sensíveis
- [ ] Remova ou ignore `allowed_users.json` se contiver dados sensíveis
- [ ] Remova ou ignore `blacklist.json` se contiver dados sensíveis
- [ ] Crie o arquivo `.env` na nuvem com as credenciais reais
- [ ] Crie os arquivos `allowed_groups.json`, `allowed_users.json` e `blacklist.json` na nuvem
- [ ] Configure todas as variáveis de ambiente necessárias

### 5. 🔐 Variáveis de ambiente obrigatórias:

No arquivo `.env` (não commitado), configure:

```env
# APIs de IA (pelo menos uma)
GROQ_API_KEY=seu_groq_api_key
# ou
OPENROUTER_API_KEY=seu_openrouter_api_key

# Administradores (separados por vírgula)
AUTHORIZED_IDS=id1@lid,id2@lid,numero

# Grupos permitidos (separados por vírgula)
ALLOWED_GROUP_NAMES=Grupo 1,Grupo 2

# Usuários permitidos para PV (separados por vírgula)
ALLOWED_USER_IDS=id1@c.us,id2@c.us

# Grupo para agendamento
SCHEDULER_TARGET_GROUP=grupo_id@g.us
```

### 6. 🚨 Se você já fez commit de dados sensíveis:

1. **IMEDIATAMENTE** revogue/altere:
   - Senhas expostas
   - Chaves de API expostas
   - Credenciais do WhatsApp

2. Remova do histórico do Git (se necessário):
   ```bash
   git filter-branch --force --index-filter \
     "git rm --cached --ignore-unmatch auth_info/" \
     --prune-empty --tag-name-filter cat -- --all
   ```

3. Force push (CUIDADO - apenas se necessário):
   ```bash
   git push origin --force --all
   ```

### 7. ✅ Após fazer deploy na nuvem:

1. Crie o arquivo `.env` com todas as variáveis
2. Crie os arquivos de configuração (allowed_groups.json, etc.)
3. Instale as dependências: `npm install`
4. Execute o bot: `npm start`

---

**Lembre-se:** Sempre verifique o `.gitignore` antes de fazer commit!


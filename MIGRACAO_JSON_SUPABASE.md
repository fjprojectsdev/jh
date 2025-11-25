# 🚀 Migração JSON → Supabase

## ✅ Arquivos Migrados

| Arquivo JSON | Tabela Supabase | Status |
|-------------|-----------------|--------|
| `leads.json` | `leads` | ✅ Implementado |
| `strikes.json` | `strikes` | ✅ Já existia |
| `banned_words.json` | `banned_words` | ✅ Já existia |
| `allowed_groups.json` | `allowed_groups` | ✅ Já existia |
| `admins.json` | `admins` | ✅ Já existia |
| `lembretes.json` | `lembretes` | ✅ Já existia |
| `scheduled.json` | `scheduled_messages` | ✅ Implementado |
| `allowed_users.json` | `allowed_users` | ✅ Implementado |
| `blacklist.json` | `blacklist` | ✅ Implementado |

## 📋 Passo a Passo

### 1. Execute o SQL
```bash
# Acesse: https://supabase.com/dashboard/project/lxqyacryiizzcyrkcfya/editor
# Cole o conteúdo de SUPABASE_SETUP.sql
# Clique em "Run"
```

### 2. Verifique as Tabelas
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public';
```

### 3. Migre Dados Existentes (Opcional)

Se você tem dados em JSON que quer preservar:

```javascript
// Execute no Node.js
import fs from 'fs';
import * as db from './functions/database.js';

// Migrar leads
const leads = JSON.parse(fs.readFileSync('leads.json', 'utf8'));
for (const lead of leads) {
    await db.saveLead(lead);
}

// Migrar palavras banidas
const banned = JSON.parse(fs.readFileSync('banned_words.json', 'utf8'));
for (const word of banned) {
    await db.addBannedWord(word);
}

// Migrar grupos permitidos
const groups = JSON.parse(fs.readFileSync('allowed_groups.json', 'utf8'));
for (const group of groups) {
    await db.addAllowedGroup(group);
}
```

## 🎯 Benefícios

✅ **Persistência Total**: Dados nunca são perdidos em deploy  
✅ **Performance**: Índices otimizados para consultas rápidas  
✅ **Escalabilidade**: Suporta milhões de registros  
✅ **Backup Automático**: Supabase faz backup diário  
✅ **Fallback**: Código mantém compatibilidade com JSON  

## 🔧 Configuração

Certifique-se que o `.env` tem:
```env
SUPABASE_URL=https://lxqyacryiizzcyrkcfya.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 📊 Monitoramento

Acesse o dashboard do Supabase:
- **Table Editor**: Ver dados em tempo real
- **SQL Editor**: Executar queries
- **Logs**: Monitorar requisições
- **Database**: Ver uso de storage

## ⚠️ Importante

- JSONs ainda funcionam como **fallback**
- Supabase é **prioridade**
- Se Supabase falhar, usa JSON local
- Não delete os JSONs ainda (segurança)

## 🚀 Deploy

Funciona em:
- ✅ Railway
- ✅ Heroku
- ✅ Render
- ✅ Vercel (Serverless)
- ✅ VPS

**Dados persistem em TODOS os ambientes!** 🎉

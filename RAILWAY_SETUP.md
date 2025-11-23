# 🚂 Configuração Railway

## Variáveis de Ambiente Obrigatórias

Configure no Railway Dashboard → Variables:

```
GROQ_API_KEY=sua_chave_groq_aqui
AUTHORIZED_IDS=5564999999999
ALLOWED_GROUP_NAMES=Nome do Grupo
DDD_PADRAO=64
COMMAND_COOLDOWN=3
```

## Variáveis Opcionais

```
SUPABASE_URL=sua_url_supabase
SUPABASE_KEY=sua_chave_supabase
WEBHOOK_URL=sua_url_webhook
```

## Deploy

1. Conecte o repositório GitHub ao Railway
2. Configure as variáveis de ambiente
3. Deploy automático será feito
4. Escaneie o QR code nos logs

## Verificação

Após deploy, verifique nos logs:
- ✅ Criado: strikes.json
- ✅ Criado: lembretes.json
- ✅ Criado: banned_words.json
- ✅ Porta configurada
- ✅ Inicialização completa

## Persistência de Dados

O Railway pode reiniciar o container. Para persistência:
- Use Supabase para backup em nuvem
- Configure SUPABASE_URL e SUPABASE_KEY

## Problemas Comuns

### Bot desconecta após reiniciar
- Normal, escaneie QR code novamente
- Considere usar sessão persistente (Supabase)

### Comandos não funcionam
- Verifique AUTHORIZED_IDS está configurado
- Verifique ALLOWED_GROUP_NAMES está correto

### IA não funciona
- Configure GROQ_API_KEY válida
- Obtenha chave grátis em: https://console.groq.com

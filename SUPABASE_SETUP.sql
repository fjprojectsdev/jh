-- Execute este SQL no Supabase SQL Editor
-- Migração completa: JSON -> PostgreSQL

-- 1. Tabela de Leads
CREATE TABLE IF NOT EXISTS leads (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    last_message TEXT,
    intent TEXT,
    confidence INTEGER,
    conversation_count INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_updated_at ON leads(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_intent ON leads(intent);
ALTER TABLE leads DISABLE ROW LEVEL SECURITY;

-- 2. Tabela de Strikes (já existe, garantir estrutura)
CREATE TABLE IF NOT EXISTS strikes (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    count INTEGER DEFAULT 0,
    violations JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strikes_user_id ON strikes(user_id);
ALTER TABLE strikes DISABLE ROW LEVEL SECURITY;

-- 3. Tabela de Palavras Banidas (já existe)
CREATE TABLE IF NOT EXISTS banned_words (
    id BIGSERIAL PRIMARY KEY,
    word TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banned_words_word ON banned_words(word);
ALTER TABLE banned_words DISABLE ROW LEVEL SECURITY;

-- 4. Tabela de Grupos Permitidos (já existe)
CREATE TABLE IF NOT EXISTS allowed_groups (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_allowed_groups_name ON allowed_groups(name);
ALTER TABLE allowed_groups DISABLE ROW LEVEL SECURITY;

-- 5. Tabela de Admins (já existe)
CREATE TABLE IF NOT EXISTS admins (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admins_user_id ON admins(user_id);
ALTER TABLE admins DISABLE ROW LEVEL SECURITY;

-- 6. Tabela de Lembretes (já existe)
CREATE TABLE IF NOT EXISTS lembretes (
    id BIGSERIAL PRIMARY KEY,
    group_id TEXT UNIQUE NOT NULL,
    config JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lembretes_group_id ON lembretes(group_id);
ALTER TABLE lembretes DISABLE ROW LEVEL SECURITY;

-- 7. Tabela de Mensagens Agendadas (scheduled.json)
DROP TABLE IF EXISTS scheduled_messages CASCADE;

CREATE TABLE scheduled_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    time TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    executed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scheduled_time ON scheduled_messages(time);
CREATE INDEX idx_scheduled_executed ON scheduled_messages(executed);
ALTER TABLE scheduled_messages DISABLE ROW LEVEL SECURITY;

-- 8. Tabela de Usuários Permitidos (allowed_users.json)
CREATE TABLE IF NOT EXISTS allowed_users (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_allowed_users_user_id ON allowed_users(user_id);
ALTER TABLE allowed_users DISABLE ROW LEVEL SECURITY;

-- 9. Tabela de Blacklist (blacklist.json)
CREATE TABLE IF NOT EXISTS blacklist (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blacklist_user_id ON blacklist(user_id);
ALTER TABLE blacklist DISABLE ROW LEVEL SECURITY;

-- 10. Tabela de Logs de Admin (já existe)
CREATE TABLE IF NOT EXISTS admin_logs (
    id BIGSERIAL PRIMARY KEY,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    group_id TEXT,
    details TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_timestamp ON admin_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON admin_logs(admin_id);
ALTER TABLE admin_logs DISABLE ROW LEVEL SECURITY;

-- 11. Tabela de Grupos de Promoção
CREATE TABLE IF NOT EXISTS promo_groups (
    id BIGSERIAL PRIMARY KEY,
    group_id TEXT UNIQUE NOT NULL,
    group_name TEXT NOT NULL,
    last_promo TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_groups_group_id ON promo_groups(group_id);
ALTER TABLE promo_groups DISABLE ROW LEVEL SECURITY;

-- 12. Tabela de Configuração de Promo
CREATE TABLE IF NOT EXISTS promo_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    enabled BOOLEAN DEFAULT TRUE,
    intervalHours INTEGER DEFAULT 6,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE promo_config DISABLE ROW LEVEL SECURITY;

-- Inserir config padrão
INSERT INTO promo_config (id, enabled, intervalHours) 
VALUES (1, true, 6) 
ON CONFLICT (id) DO NOTHING;

-- 13. Tabela de Mensagens de Promoção
CREATE TABLE IF NOT EXISTS promo_messages (
    id BIGSERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_messages_active ON promo_messages(active);
ALTER TABLE promo_messages DISABLE ROW LEVEL SECURITY;

-- Inserir mensagens padrão
INSERT INTO promo_messages (message, active) VALUES
('🤖 *iMavyBot - Automação Profissional para WhatsApp*

✅ Anti-spam com IA
✅ Sistema de strikes automático
✅ Dashboard web moderno
✅ Lembretes e agendamentos
✅ Moderação inteligente 24/7

💰 *Quer automatizar seu grupo?*
📱 Chame: wa.me/5564993344024

_Mensagem automática - iMavyBot_', true),

('🚀 *Cansado de moderar grupo manualmente?*

O *iMavyBot* faz tudo por você:
• Bane spammers automaticamente
• Abre/fecha grupo em horários
• Envia boas-vindas personalizadas
• Dashboard para gerenciar tudo

💡 *Teste grátis por 7 dias!*
📲 Contato: wa.me/5564993344024

_iMavyBot - Seu grupo no piloto automático_', true),

('⚡ *iMavyBot - O Bot Mais Completo do WhatsApp*

🎯 Recursos:
✓ IA para detectar spam e toxicidade
✓ Sistema de strikes (3 = ban)
✓ Comandos administrativos
✓ Backup automático
✓ Suporte 24/7

🔥 *Promoção: R$ 49,90/mês*
(Primeiros 10 clientes: R$ 29,90)

📞 Chame agora: wa.me/5564993344024

_Automação profissional para grupos_', true)
ON CONFLICT DO NOTHING;

-- Comentários
COMMENT ON TABLE leads IS 'Leads capturados pela IA de vendas';
COMMENT ON TABLE strikes IS 'Sistema de strikes por violações';
COMMENT ON TABLE scheduled_messages IS 'Mensagens agendadas (substitui scheduled.json)';
COMMENT ON TABLE allowed_users IS 'Usuários permitidos (substitui allowed_users.json)';
COMMENT ON TABLE blacklist IS 'Usuários bloqueados (substitui blacklist.json)';
COMMENT ON TABLE promo_groups IS 'Grupos que recebem auto-promoção';
COMMENT ON TABLE promo_messages IS 'Mensagens de promoção (aleatórias)';

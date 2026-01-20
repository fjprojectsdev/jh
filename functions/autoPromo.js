// Sistema de Auto-Promoção
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMO_FILE = path.join(__dirname, '..', 'promo_config.json');

const DEFAULT_MESSAGES = [
    `🤖 *iMavyBot - Automação Profissional para WhatsApp*

✅ Anti-spam com IA
✅ Sistema de strikes automático
✅ Dashboard web moderno
✅ Lembretes e agendamentos
✅ Moderação inteligente 24/7

💰 *Quer automatizar seu grupo?*
📱 Chame: wa.me/5564993344024

_Mensagem automática - iMavyBot_`,

    `🚀 *Cansado de moderar grupo manualmente?*

O *iMavyBot* faz tudo por você:
• Bane spammers automaticamente
• Abre/fecha grupo em horários
• Envia boas-vindas personalizadas
• Dashboard para gerenciar tudo

💡 *Teste grátis por 7 dias!*
📲 Contato: wa.me/5564993344024

_iMavyBot - Seu grupo no piloto automático_`,

    `⚡ *iMavyBot - O Bot Mais Completo do WhatsApp*

🎯 Recursos:
✓ IA para detectar spam e toxicidade
✓ Sistema de strikes (3 = ban)
✓ Comandos administrativos
✓ Backup automático
✓ Suporte 24/7

🔥 *Promoção: R$ 49,90/mês*
(Primeiros 10 clientes: R$ 29,90)

📞 Chame agora: wa.me/5564993344024

_Automação profissional para grupos_`
];

function loadConfig() {
    if (!fs.existsSync(PROMO_FILE)) {
        const defaultConfig = { enabled: false, intervalHours: 6, groups: [], messages: DEFAULT_MESSAGES };
        fs.writeFileSync(PROMO_FILE, JSON.stringify(defaultConfig, null, 2));
        return defaultConfig;
    }
    return JSON.parse(fs.readFileSync(PROMO_FILE, 'utf8'));
}

function saveConfig(config) {
    fs.writeFileSync(PROMO_FILE, JSON.stringify(config, null, 2));
}

export function addPromoGroup(groupId, groupName) {
    const config = loadConfig();
    if (!config.groups.find(g => g.id === groupId)) {
        config.groups.push({ id: groupId, name: groupName, lastPromo: null });
        saveConfig(config);
    }
}

export function removePromoGroup(groupId) {
    const config = loadConfig();
    config.groups = config.groups.filter(g => g.id !== groupId);
    saveConfig(config);
}

export function listPromoGroups() {
    return loadConfig().groups;
}

export function setPromoInterval(hours) {
    const config = loadConfig();
    config.intervalHours = hours;
    saveConfig(config);
}

export function togglePromo(enabled) {
    const config = loadConfig();
    config.enabled = enabled;
    saveConfig(config);
}

export function getPromoConfig() {
    return loadConfig();
}

export function getRandomPromoMessage() {
    const config = loadConfig();
    const messages = config.messages || DEFAULT_MESSAGES;
    return messages[Math.floor(Math.random() * messages.length)];
}

export function startAutoPromo(sock) {
    const config = getPromoConfig();
    console.log(`📢 Auto-promoção ativada: a cada ${config.intervalHours}h em ${config.groups.length} grupos`);

    setInterval(async () => {
        const currentConfig = getPromoConfig();
        if (!currentConfig.enabled) return;

        const intervalMs = currentConfig.intervalHours * 60 * 60 * 1000;

        for (const group of currentConfig.groups) {
            try {
                const now = Date.now();
                const lastPromo = group.lastPromo || 0;

                if (now - lastPromo < intervalMs) continue;

                const randomMessage = getRandomPromoMessage();

                if (randomMessage && randomMessage.trim().length > 0) {
                    await sock.sendMessage(group.id, { text: randomMessage });
                    console.log(`📢 Anúncio enviado para: ${group.name}`);
                }
            } catch (e) {
                console.error(`Erro ao enviar promo para ${group.name}:`, e.message);
            }
        }
    }, 60 * 1000);
}

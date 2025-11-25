// Sistema de Auto-Promoção
import * as db from './database.js';

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
    ]
];

export async function addPromoGroup(groupId, groupName) {
    return await db.addPromoGroup(groupId, groupName);
}

export async function removePromoGroup(groupId) {
    return await db.removePromoGroup(groupId);
}

export async function listPromoGroups() {
    return await db.getPromoGroups();
}

export async function setPromoInterval(hours) {
    return await db.setPromoConfig('intervalHours', hours);
}

export async function togglePromo(enabled) {
    return await db.setPromoConfig('enabled', enabled);
}

export async function getPromoConfig() {
    return await db.getPromoConfig();
}

export async function getRandomPromoMessage() {
    const messages = await db.getPromoMessages();
    if (messages.length === 0) return DEFAULT_MESSAGES[0];
    return messages[Math.floor(Math.random() * messages.length)].message;
}

export async function startAutoPromo(sock) {
    const config = await getPromoConfig();
    
    if (!config.enabled) {
        console.log('🚫 Auto-promoção desabilitada');
        return;
    }

    const groups = await listPromoGroups();
    console.log(`📢 Auto-promoção ativada: a cada ${config.intervalHours}h em ${groups.length} grupos`);

    setInterval(async () => {
        const currentConfig = await getPromoConfig();
        if (!currentConfig.enabled) return;

        const currentGroups = await listPromoGroups();
        const intervalMs = currentConfig.intervalHours * 60 * 60 * 1000;

        for (const group of currentGroups) {
            try {
                const now = Date.now();
                const lastPromo = group.last_promo ? new Date(group.last_promo).getTime() : 0;
                
                if (now - lastPromo < intervalMs) continue;

                const randomMessage = await getRandomPromoMessage();
                
                await sock.sendMessage(group.group_id, { text: randomMessage });
                await db.updatePromoGroupLastSent(group.group_id);
                
                console.log(`📢 Anúncio enviado para: ${group.group_name}`);
                
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (e) {
                console.error(`Erro ao enviar promo para ${group.group_name}:`, e.message);
            }
        }
    }, 60 * 60 * 1000);
}

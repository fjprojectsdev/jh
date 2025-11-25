import cron from 'node-cron';
import * as db from './database.js';

export function scheduleGroupMessages(sock) {
    console.log('📅 Agendador automático ativado (00:00 fechar | 07:00 abrir)');
    
    // Fechar grupos às 00:00
    cron.schedule('0 0 * * *', async () => {
        console.log('🌙 Executando fechamento automático...');
        try {
            const allowedGroups = await db.getAllowedGroups();
            const allGroups = await sock.groupFetchAllParticipating();
            
            for (const groupId in allGroups) {
                const group = allGroups[groupId];
                if (allowedGroups.includes(group.subject)) {
                    await sock.groupSettingUpdate(groupId, 'announcement');
                    await sock.sendMessage(groupId, { 
                        text: '🌙 *Grupo fechado!* 🌙\n\nO horário de descanso chegou 😴✨\nMensagens estarão desativadas até às 07:00.\nAproveite para recarregar as energias 🔋💤\nNos vemos amanhã! 🌞💬' 
                    });
                    console.log(`✅ Grupo "${group.subject}" fechado`);
                    await db.logAdminAction('SYSTEM', 'auto_close', null, groupId, 'Fechamento automático 00:00');
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        } catch (err) {
            console.error('❌ Erro ao fechar grupos:', err);
        }
    }, { timezone: 'America/Sao_Paulo' });
    
    // Abrir grupos às 07:00
    cron.schedule('0 7 * * *', async () => {
        console.log('☀️ Executando abertura automática...');
        try {
            const allowedGroups = await db.getAllowedGroups();
            const allGroups = await sock.groupFetchAllParticipating();
            
            for (const groupId in allGroups) {
                const group = allGroups[groupId];
                if (allowedGroups.includes(group.subject)) {
                    await sock.groupSettingUpdate(groupId, 'not_announcement');
                    await sock.sendMessage(groupId, { 
                        text: '☀️ *Bom dia!* ☀️\n\nO grupo está aberto novamente! 🎉\nVamos começar o dia com energia! 💪✨' 
                    });
                    console.log(`✅ Grupo "${group.subject}" aberto`);
                    await db.logAdminAction('SYSTEM', 'auto_open', null, groupId, 'Abertura automática 07:00');
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        } catch (err) {
            console.error('❌ Erro ao abrir grupos:', err);
        }
    }, { timezone: 'America/Sao_Paulo' });
    
    console.log('✅ Cron jobs registrados: 00:00 (fechar) | 07:00 (abrir)');
}
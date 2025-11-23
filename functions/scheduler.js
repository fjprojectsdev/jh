import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function scheduleGroupMessages(sock) {
    console.log('📅 Agendador automático ativado para todos os grupos autorizados');
    
    // Fechar grupos às 00:00 (horário de Brasília)
    cron.schedule('0 0 * * *', async () => {
        try {
            const allowedPath = path.join(__dirname, '..', 'allowed_groups.json');
            const allowedGroups = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
            
            const allGroups = await sock.groupFetchAllParticipating();
            
            for (const groupId in allGroups) {
                const group = allGroups[groupId];
                if (allowedGroups.includes(group.subject)) {
                    await sock.groupSettingUpdate(groupId, 'announcement');
                    await sock.sendMessage(groupId, { 
                        text: '🌙 *Grupo fechado!* 🌙\n\nO horário de descanso chegou 😴✨\nMensagens estarão desativadas até às 07:00 da manhã (horário de Brasília).\nAproveite para recarregar as energias 🔋💤\nNos vemos amanhã! 🌞💬' 
                    });
                    console.log(`✅ Grupo "${group.subject}" fechado às 00:00`);
                }
            }
        } catch (err) {
            console.error('❌ Erro ao fechar grupos:', err);
        }
    }, { timezone: 'America/Sao_Paulo' });
    
    // Abrir grupos às 07:00
    cron.schedule('0 7 * * *', async () => {
        try {
            const allowedPath = path.join(__dirname, '..', 'allowed_groups.json');
            const allowedGroups = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
            
            const allGroups = await sock.groupFetchAllParticipating();
            
            for (const groupId in allGroups) {
                const group = allGroups[groupId];
                if (allowedGroups.includes(group.subject)) {
                    await sock.groupSettingUpdate(groupId, 'not_announcement');
                    await sock.sendMessage(groupId, { 
                        text: '☀️ *Bom dia!* ☀️\n\nO grupo está aberto novamente! 🎉\nVamos começar o dia com energia! 💪✨' 
                    });
                    console.log(`✅ Grupo "${group.subject}" aberto às 07:00`);
                }
            }
        } catch (err) {
            console.error('❌ Erro ao abrir grupos:', err);
        }
    }, { timezone: 'America/Sao_Paulo' });
}
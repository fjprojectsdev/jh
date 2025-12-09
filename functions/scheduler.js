import cron from 'node-cron';
import * as db from './database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'schedule_config.json');

function getScheduleConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) {}
    return { openTime: '07:00', closeTime: '00:00' };
}

export function scheduleGroupMessages(sock) {
    const config = getScheduleConfig();
    const [closeHour, closeMin] = config.closeTime.split(':');
    const [openHour, openMin] = config.openTime.split(':');
    
    console.log(`📅 Agendador: ${config.closeTime} fechar | ${config.openTime} abrir`);
    
    // Fechar grupos
    cron.schedule(`${closeMin} ${closeHour} * * *`, async () => {
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
    
    // Abrir grupos
    cron.schedule(`${openMin} ${openHour} * * *`, async () => {
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
    
    console.log(`✅ Cron jobs: ${config.closeTime} (fechar) | ${config.openTime} (abrir)`);
}
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { sendSafeMessage } from './messageHandler.js';
import { isRestrictedGroupName } from './groupPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'schedule_config.json');
const ALLOWED_FILE = path.join(__dirname, '..', 'allowed_groups.json');

function getScheduleConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) { }
    return { openTime: '07:00', closeTime: '00:00' };
}

function getAllowedGroups() {
    try {
        if (fs.existsSync(ALLOWED_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf8'));
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map((entry) => {
                    if (typeof entry === 'string') {
                        return { name: entry, permissions: { openClose: true } };
                    }
                    if (!entry || typeof entry !== 'object') return null;
                    if (typeof entry.name !== 'string') return null;
                    return {
                        name: entry.name,
                        permissions: {
                            openClose: typeof entry.permissions?.openClose === 'boolean'
                                ? entry.permissions.openClose
                                : true
                        }
                    };
                })
                .filter(Boolean);
        }
    } catch (e) { }
    return [];
}

export function scheduleGroupMessages(sock) {
    const config = getScheduleConfig();
    const [closeHour, closeMin] = config.closeTime.split(':');
    const [openHour, openMin] = config.openTime.split(':');

    console.log(`📅 Agendador: ${config.closeTime} fechar | ${config.openTime} abrir`);

    // Fechar grupos
    cron.schedule(`${closeMin} ${closeHour} * * *`, async () => {
        console.log('🌙 Fechamento automático iniciado');
        try {
            const allowedGroups = getAllowedGroups();
            const allGroups = await sock.groupFetchAllParticipating();

            for (const groupId in allGroups) {
                const group = allGroups[groupId];
                const allowedGroup = allowedGroups.find((g) => g.name === group.subject);
                if (allowedGroup && allowedGroup.permissions.openClose && !isRestrictedGroupName(group.subject)) {
                    await sock.groupSettingUpdate(groupId, 'announcement');
                    await sendSafeMessage(sock, groupId, {
                        text: 'Grupo Temporariamente Fechado\n\nO envio de mensagens está desativado até 08:00.\n\nA funcionalidade será reativada automaticamente no horário programado.'
                    });
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            console.log('✅ Fechamento concluído');
        } catch (err) {
            console.error('❌ Erro ao fechar:', err.message);
        }
    }, { timezone: 'America/Sao_Paulo' });

    // Abrir grupos
    cron.schedule(`${openMin} ${openHour} * * *`, async () => {
        console.log('☀️ Abertura automática iniciada');
        try {
            const allowedGroups = getAllowedGroups();
            const allGroups = await sock.groupFetchAllParticipating();

            for (const groupId in allGroups) {
                const group = allGroups[groupId];
                const allowedGroup = allowedGroups.find((g) => g.name === group.subject);
                if (allowedGroup && allowedGroup.permissions.openClose && !isRestrictedGroupName(group.subject)) {
                    await sock.groupSettingUpdate(groupId, 'not_announcement');
                    await sendSafeMessage(sock, groupId, {
                        text: 'Grupo Aberto\n\nAs mensagens foram reativadas.\nDesejamos a todos um excelente dia.'
                    });
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            console.log('✅ Abertura concluída');
        } catch (err) {
            console.error('❌ Erro ao abrir:', err.message);
        }
    }, { timezone: 'America/Sao_Paulo' });

    console.log(`✅ Cron jobs: ${config.closeTime} (fechar) | ${config.openTime} (abrir)`);
}

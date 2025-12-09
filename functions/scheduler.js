import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_GROUPS_FILE = path.join(__dirname, '..', 'allowed_groups.json');

function getAllowedGroups() {
    try {
        if (fs.existsSync(ALLOWED_GROUPS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ALLOWED_GROUPS_FILE, 'utf8'));
            return Array.isArray(data) ? data : [];
        }
    } catch (e) {
        console.error('Erro ao ler grupos permitidos:', e);
    }
    return [];
}

export function scheduleGroupMessages(sock) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📅 AGENDADOR AUTOMÁTICO INICIADO');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const allowedGroups = getAllowedGroups();
    console.log(`📋 Grupos cadastrados: ${allowedGroups.length}`);
    allowedGroups.forEach((g, i) => console.log(`   ${i+1}. ${g}`));
    
    console.log('\n⏰ Horários configurados:');
    console.log('   🌙 Fechar: 00:00 (meia-noite)');
    console.log('   ☀️  Abrir:  07:00 (manhã)');
    console.log('   🌎 Timezone: America/Sao_Paulo (Brasília)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Fechar grupos às 00:00
    const closeJob = cron.schedule('0 0 * * *', async () => {
        console.log('🌙 Executando fechamento automático...');
        try {
            const allowedGroups = getAllowedGroups();
            const allGroups = await sock.groupFetchAllParticipating();
            
            for (const groupId in allGroups) {
                const group = allGroups[groupId];
                if (allowedGroups.includes(group.subject)) {
                    await sock.groupSettingUpdate(groupId, 'announcement');
                    await sock.sendMessage(groupId, { 
                        text: '🌙 *Grupo fechado!* 🌙\n\nO horário de descanso chegou 😴✨\nMensagens estarão desativadas até às 07:00.\nAproveite para recarregar as energias 🔋💤\nNos vemos amanhã! 🌞💬' 
                    });
                    console.log(`✅ Grupo "${group.subject}" fechado`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        } catch (err) {
            console.error('❌ Erro ao fechar grupos:', err);
        }
    }, { timezone: 'America/Sao_Paulo' });
    
    console.log('✅ Cron job FECHAR registrado: 00:00 (America/Sao_Paulo)');
    
    // Abrir grupos às 07:00
    const openJob = cron.schedule('0 7 * * *', async () => {
        console.log('☀️ Executando abertura automática...');
        try {
            const allowedGroups = getAllowedGroups();
            const allGroups = await sock.groupFetchAllParticipating();
            
            for (const groupId in allGroups) {
                const group = allGroups[groupId];
                if (allowedGroups.includes(group.subject)) {
                    await sock.groupSettingUpdate(groupId, 'not_announcement');
                    await sock.sendMessage(groupId, { 
                        text: '☀️ *Bom dia!* ☀️\n\nO grupo está aberto novamente! 🎉\nVamos começar o dia com energia! 💪✨' 
                    });
                    console.log(`✅ Grupo "${group.subject}" aberto`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        } catch (err) {
            console.error('❌ Erro ao abrir grupos:', err);
        }
    }, { timezone: 'America/Sao_Paulo' });
    
    console.log('✅ Cron job ABRIR registrado: 07:00 (America/Sao_Paulo)');
    console.log('\n✅ Sistema de agendamento ativo e funcionando!\n');
    
    // Verificar status dos jobs
    setInterval(() => {
        const now = new Date();
        const brasiliaTime = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        console.log(`⏰ [${brasiliaTime}] Scheduler ativo - Próximo: ${brasiliaTime < '07:00' ? '07:00 (abrir)' : '00:00 (fechar)'}`);
    }, 3600000); // Log a cada 1 hora
}
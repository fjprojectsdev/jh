// Sistema de Strikes e Moderação Automática
// 1 strike = Aviso
// 2 strikes = Aviso severo (última chance)
// 3 strikes = Expulsão automática

import { getUserName } from './userInfo.js';
import * as db from './database.js';
import { sendSafeMessage } from './messageHandler.js';

export async function addStrike(userId, violation) {
    return await db.addStrike(userId, violation);
}

export async function getStrikes(userId) {
    const data = await db.getStrikes(userId);
    return data.count || 0;
}

export async function resetStrikes(userId) {
    await db.resetStrikes(userId);
}

export async function applyPunishment(sock, groupId, userId) {
    const strikeCount = await getStrikes(userId);
    const userNumber = userId.split('@')[0];
    const userName = await getUserName(sock, userId, groupId);
    
    try {
        if (strikeCount === 1) {
            // 1ª violação: Aviso
            const avisoMsg = `Aviso de Moderação

@${userNumber}, foi registrado um aviso por violação das regras do grupo.

• Strikes: 1 de 3
• Atingir 3 avisos resulta em remoção automática

Consulte as regras para evitar novas ocorrências.`;

            await sendSafeMessage(sock, groupId, {
                text: avisoMsg,
                mentions: [userId]
            });

            console.log(`⚠️ Strike 1/3 aplicado para ${userNumber}`);

        } else if (strikeCount === 2) {
            // 2ª violação: Aviso severo
            const avisoMsg = `Aviso de Moderação — Atenção

@${userNumber}, este é o seu segundo aviso.

• Strikes: 2 de 3
• Próxima violação: remoção automática do grupo

Recomendamos atenção total às regras para evitar penalidades.`;

            await sendSafeMessage(sock, groupId, {
                text: avisoMsg,
                mentions: [userId]
            });
            
            console.log(`🚨 Strike 2/3 aplicado para ${userNumber} - ÚLTIMA CHANCE`);
            
        } else if (strikeCount >= 3) {
            // 3ª violação: Expulsão
            const avisoMsg = `Ação de Moderação Executada

@${userNumber} foi removido do grupo após atingir o limite de avisos.

• Strikes: 3 de 3
• Motivo: Violação recorrente das regras
• Ação: Remoção automática

Esta medida visa preservar a ordem e a qualidade do grupo.`;

            await sendSafeMessage(sock, groupId, {
                text: avisoMsg,
                mentions: [userId]
            });
            
            // Remover do grupo
            await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
            
            console.log(`🚫 Strike 3/3 aplicado para ${userNumber} - EXPULSO`);
            
            // Resetar strikes após expulsão
            resetStrikes(userId);
        }
        
    } catch (error) {
        console.error('❌ Erro ao aplicar punição:', error.message);
    }
}

export async function getViolationHistory(userId) {
    const data = await db.getStrikes(userId);
    return data.violations || [];
}

export async function sendWelcomeMessage(sock, groupId, newMemberJid) {
    try {
        // Obter informações do grupo
        const groupMetadata = await sock.groupMetadata(groupId);
        const groupName = groupMetadata.subject;
        
        // Extrair JID correto se for objeto
        let memberJid = newMemberJid;
        if (typeof newMemberJid === 'object' && newMemberJid.id) {
            memberJid = newMemberJid.id;
        }
        
        // Obter nome do usuário
        const userNumber = memberJid.split('@')[0];
        
        const welcomeText = `Bem-vindo(a) ao grupo, @${userNumber}.

Antes de interagir, recomendamos a leitura das regras:
/regras

Este espaço é voltado para troca construtiva e convivência respeitosa.
Contamos com sua colaboração.

Mensagem automática — iMavyAgent`;
        
        await sock.sendMessage(groupId, { 
            text: welcomeText,
            mentions: [memberJid]
        });
        
        console.log(`✅ Mensagem de boas-vindas enviada para ${userNumber} no grupo ${groupName}`);
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem de boas-vindas:', error);
    }
}

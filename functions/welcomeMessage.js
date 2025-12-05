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
        
        const welcomeText = `🎉 Seja muito bem-vindo(a)! 🎉

━━━━━━━━━━━━━━━━━

👋 Olá, @${userNumber}!

É um prazer tê-lo(a) aqui.

Antes de começar a interagir:

📜 Leia as regras: /regras

✨ Mantenha o respeito, compartilhe boas ideias e aproveite o espaço!
Lembre-se: a convivência saudável depende de todos nós 💪

━━━━━━━━━━━━━━━━━

🤖 Mensagem automática enviada por: iMavyAgent
━━━━━━━━━━━━━━━━━`;
        
        await sock.sendMessage(groupId, { 
            text: welcomeText,
            mentions: [memberJid]
        });
        
        console.log(`✅ Mensagem de boas-vindas enviada para ${userNumber} no grupo ${groupName}`);
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem de boas-vindas:', error);
    }
}

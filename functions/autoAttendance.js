// Sistema de Atendimento Automático
const KEYWORDS = [
    'preço', 'preco', 'valor', 'valores', 'quanto custa', 'custo', 'plano', 'planos',
    'contratar', 'contratação', 'contratacao', 'serviço', 'servico', 'serviços', 'servicos',
    'como funciona', 'funciona', 'informações', 'informacoes', 'info',
    'quero contratar', 'tenho interesse', 'interessado', 'orçamento', 'orcamento'
];



const ATTENDANCE_MESSAGE = `👋 Olá! Aqui estão nossos planos atualizados:

📦 *1 Grupo* – R$ 100/mês
Comandos padrão, IA de moderação, anti-link, anti-flood, boas-vindas e suporte normal.

📦 *2 Grupos* – R$ 200/mês
Tudo do plano anterior + moderação IA em até 2 grupos simultâneos.

⭐ *3 Grupos (MAIS VENDIDO)* – R$ 250/mês
Tudo do plano anterior + suporte para até 3 grupos. Melhor custo-benefício!

👑 *Premium Empresarial* – R$ 1.000/mês
Bot personalizado com nome, logo, mensagens e comportamento da sua empresa. Até 3 grupos incluídos + suporte prioritário e consultoria.

━━━━━━━━━━━━━━━━
💬 Quer que eu te ajude a contratar o melhor plano para o seu caso?`;

export function detectClientInterest(text) {
    const lowerText = text.toLowerCase();
    return KEYWORDS.some(keyword => lowerText.includes(keyword));
}

export async function sendAttendanceMessage(sock, chatId) {
    try {
        await sock.sendMessage(chatId, { text: ATTENDANCE_MESSAGE });
        console.log(`✅ Mensagem de atendimento enviada para: ${chatId}`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem de atendimento:', error);
        return false;
    }
}

// Rastrear usuários já atendidos (evitar spam)
const attendedUsers = new Set();
const verifiedUsers = new Set();

export function shouldSendAttendance(userId) {
    if (attendedUsers.has(userId)) {
        return false;
    }
    attendedUsers.add(userId);
    
    // Limpar após 24h
    setTimeout(() => {
        attendedUsers.delete(userId);
    }, 24 * 60 * 60 * 1000);
    
    return true;
}

export async function sendVerificationMessage(sock, chatId) {
    try {
        await sock.sendMessage(chatId, { 
            text: `👋 Olá! Posso lhe ajudar?

💡 Responda *SIM* se deseja conhecer nossos serviços de automação para WhatsApp.`
        });
        console.log(`✅ Mensagem de verificação enviada para: ${chatId}`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao enviar verificação:', error);
        return false;
    }
}

export function markAsVerified(userId) {
    verifiedUsers.add(userId);
    setTimeout(() => verifiedUsers.delete(userId), 5 * 60 * 1000); // 5 min
}

export function isVerified(userId) {
    return verifiedUsers.has(userId);
}

export async function notifyAttendants(sock, clientId, clientNumber, getAdmins) {
    const msg = `🔔 *NOVO CLIENTE INTERESSADO!*

👤 Cliente: ${clientNumber}
🆔 ID: ${clientId}

💬 O cliente digitou */valores* e está aguardando contato!

⏰ ${new Date().toLocaleString('pt-BR')}`;
    
    const admins = await getAdmins();
    
    // Excluir admin cliente que não precisa receber notificações
    const excludedAdmins = ['225919675449527@lid'];
    
    for (const admin of admins) {
        try {
            const adminJid = admin.id || admin.user_id;
            const formattedJid = adminJid.includes('@') ? adminJid : `${adminJid}@s.whatsapp.net`;
            
            // Pular admin excluído
            if (excludedAdmins.includes(adminJid) || excludedAdmins.includes(formattedJid)) {
                console.log(`⏭️ Pulando notificação para admin cliente: ${formattedJid}`);
                continue;
            }
            
            await sock.sendMessage(formattedJid, { text: msg });
            console.log(`✅ Notificação enviada para admin: ${formattedJid}`);
        } catch (e) {
            console.error('Erro ao notificar admin:', e);
        }
    }
}

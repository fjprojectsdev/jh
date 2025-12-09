// Agendamento de mensagens
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULED_FILE = path.join(__dirname, '..', 'scheduled.json');

let scheduledMessages = [];

function loadScheduled() {
    try {
        if (fs.existsSync(SCHEDULED_FILE)) {
            scheduledMessages = JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Erro ao carregar agendamentos:', e);
    }
}

function saveScheduled() {
    try {
        fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduledMessages, null, 2));
    } catch (e) {
        console.error('Erro ao salvar agendamentos:', e);
    }
}

export function scheduleMessage(groupId, time, message) {
    const [hours, minutes] = time.split(':').map(Number);
    const now = new Date();
    const scheduled = new Date();
    scheduled.setHours(hours, minutes, 0, 0);
    
    if (scheduled <= now) {
        scheduled.setDate(scheduled.getDate() + 1);
    }
    
    const id = Date.now().toString();
    scheduledMessages.push({ id, groupId, time, message, timestamp: scheduled.getTime() });
    saveScheduled();
    
    return { id, scheduledFor: scheduled.toLocaleString('pt-BR') };
}

export function startScheduler(sock) {
    loadScheduled();
    
    setInterval(() => {
        const now = Date.now();
        const toSend = scheduledMessages.filter(msg => msg.timestamp <= now);
        
        for (const msg of toSend) {
            sock.sendMessage(msg.groupId, { text: msg.message }).catch(console.error);
            scheduledMessages = scheduledMessages.filter(m => m.id !== msg.id);
        }
        
        if (toSend.length > 0) saveScheduled();
    }, 30000); // Verifica a cada 30s
}

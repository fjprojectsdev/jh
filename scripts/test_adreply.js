
import { buildReminderPayload } from '../functions/linkPreview.js';
import fs from 'fs';

async function test() {
    console.log('\n--- 1. Link Genérico (Sem Título Custom) ---');
    const p1 = await buildReminderPayload('Veja isso https://www.google.com');
    console.log(`Title: "${p1.contextInfo?.externalAdReply?.title}" (Esperado: "Confira este link")`);

    console.log('\n--- 2. Link WhatsApp (Sem Título Custom) ---');
    const p2 = await buildReminderPayload('Grupo: https://chat.whatsapp.com/invite/123');
    console.log(`Title: "${p2.contextInfo?.externalAdReply?.title}" (Esperado: "Convite para grupo do WhatsApp")`);

    console.log('\n--- 3. Título Customizado ---');
    const p3 = await buildReminderPayload('Olha só titulo="Meu Título Personalizado" https://www.google.com');
    console.log(`Title: "${p3.contextInfo?.externalAdReply?.title}" (Esperado: "Meu Título Personalizado")`);

    console.log('\n--- 4. Título Customizado em WhatsApp ---');
    const p4 = await buildReminderPayload('Novo Grupo title="Grupo VIP" https://chat.whatsapp.com/invite/XYZ');
    console.log(`Title: "${p4.contextInfo?.externalAdReply?.title}" (Esperado: "Grupo VIP")`);
}

test();

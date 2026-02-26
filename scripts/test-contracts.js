process.env.IMAVY_ALLOW_SUPABASE_FALLBACK = process.env.IMAVY_ALLOW_SUPABASE_FALLBACK || 'true';

const sentMessages = [];

const mockSock = {
    groupMetadata: async () => ({ subject: 'Test Group', participants: [] }),
    groupParticipantsUpdate: async () => { },
    sendMessage: async (jid, content) => {
        sentMessages.push({ jid, content });
        return { key: { id: `mock-${Date.now()}` } };
    },
    user: { id: 'bot@s.whatsapp.net' }
};

global.sock = mockSock;

function createMockMessage(text, isGroup = true) {
    const remoteJid = isGroup ? '123456@g.us' : '5511999999999@s.whatsapp.net';
    return {
        key: {
            remoteJid,
            participant: isGroup ? '5511888888888@s.whatsapp.net' : undefined,
            fromMe: false
        },
        message: {
            conversation: text
        }
    };
}

const commandsToTest = [
    { cmd: '/Snappy', expected: '0x3a9e15b28E099708D0812E0843a9Ed70c508FB4b' },
    { cmd: '/Nix', expected: '0xBe96fcF736AD906b1821Ef74A0e4e346C74e6221' },
    { cmd: '/Coffee', expected: '0x2cAA9De4E4BB8202547afFB19b5830DC16184451' },
    { cmd: '/Lux', expected: '0xa3baAAD9C19805f52cFa2490700C297359b4fA52' },
    { cmd: '/Kenesis', expected: '0x76d7966227939b67D66FDB1373A0808ac53Ca9ad' },
    { cmd: '/Dcar', expected: '0xe1f7DD2812e91D1f92a8Fa1115f3ACA4aff82Fe5' },
    { cmd: '/Fsx', expected: '0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a' }
];

function normalizeText(content) {
    if (!content) return '';
    if (typeof content.text === 'string') return content.text;
    if (typeof content.caption === 'string') return content.caption;
    return '';
}

async function runTests() {
    const { handleGroupMessages } = await import('../functions/groupResponder.js');

    let hasFailure = false;
    console.log('--- Iniciando Testes de Comandos de Contrato ---');

    for (const test of commandsToTest) {
        sentMessages.length = 0;
        const msg = createMockMessage(test.cmd);
        await handleGroupMessages(mockSock, msg);

        const payload = sentMessages.map((s) => normalizeText(s.content)).join('\n');
        if (!payload.toLowerCase().includes(test.expected.toLowerCase())) {
            hasFailure = true;
            console.error(`❌ Falha: ${test.cmd} nao retornou o contrato esperado`);
            console.error(`Esperado: ${test.expected}`);
            console.error(`Recebido: ${payload || '<sem texto>'}`);
        } else {
            console.log(`✅ OK: ${test.cmd}`);
        }
    }

    if (hasFailure) {
        process.exitCode = 1;
        return;
    }

    console.log('✅ Testes de contratos concluídos com sucesso.');
}

await runTests();
process.exit(process.exitCode || 0);

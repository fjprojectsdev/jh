
import { handleGroupMessages } from '../functions/groupResponder.js';
import { fileURLToPath } from 'url';
import path from 'path';

// Mock dependencies
const mockSock = {
    groupMetadata: async (jid) => ({ subject: 'Test Group', participants: [] }),
    groupParticipantsUpdate: async () => { },
    sendMessage: async (jid, content) => {
        console.log(`[MOCK SEND] To: ${jid} | Content:`, content);
        return { key: { id: 'mock-msg-id' } };
    },
    user: { id: 'bot@s.whatsapp.net' }
};

// Mock global.sock
global.sock = mockSock;

// Helper to create a mock message
const createMockMessage = (text, isGroup = true) => {
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
};

const commandsToTest = [
    { cmd: '/Snappy', expected: '0x3a9e15b28E099708D0812E0843a9Ed70c508FB4b' },
    { cmd: '/Nix', expected: '0xBe96fcF736AD906b1821Ef74A0e4e346C74e6221' },
    { cmd: '/Coffee', expected: '0x2cAA9De4E4BB8202547afFB19b5830DC16184451' },
    { cmd: '/Lux', expected: '0xa3baAAD9C19805f52cFa2490700C297359b4fA52' },
    { cmd: '/Kenesis', expected: '0x76d7966227939b67D66FDB1373A0808ac53Ca9ad' },
    { cmd: '/Dcar', expected: '0xe1f7DD2812e91D1f92a8Fa1115f3ACA4aff82Fe5' },
    { cmd: '/Fsx', expected: '0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a' }
];

async function runTests() {
    console.log('--- Iniciando Testes de Comandos de Contrato ---');

    // Override sendSafeMessage for capturing output
    // We need to mock the module export, but ES modules are read-only.
    // Instead, we relies on console logs from the mockSock or we can assume successful execution if no error.
    // For this simple script, we'll listen to the console.log output visually or capture it if possible.
    // Better yet, let's just run it and see the logs.

    for (const test of commandsToTest) {
        console.log(`\nTestando: ${test.cmd}`);
        const msg = createMockMessage(test.cmd);
        try {
            await handleGroupMessages(mockSock, msg);
        } catch (e) {
            console.error(`ERRO no comando ${test.cmd}:`, e);
        }
    }

    console.log('\n--- Teste PV (Privado) ---');
    // Teste aleatório em PV
    const pvMsg = createMockMessage('/Snappy', false);
    await handleGroupMessages(mockSock, pvMsg);

    console.log('\n--- Testes Concluídos ---');
}

runTests();

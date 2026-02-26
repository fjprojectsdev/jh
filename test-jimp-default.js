import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');

async function test() {
    try {
        const image = new Jimp({ width: 100, height: 100, color: 0xffffffff });
        const buffer = await image.getBuffer('image/png');
        console.log('✅ Jimp inicializado e buffer PNG gerado:', buffer.length);
    } catch (error) {
        console.error('❌ Erro ao testar Jimp:', error);
        process.exitCode = 1;
    }
}

await test();

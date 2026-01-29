import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');

async function test() {
    console.log('Criando imagem...');
    const img = new Jimp({ width: 100, height: 100, color: 0xffffffff });
    console.log('Imagem criada.');

    console.log('Chamando write...');
    img.write('test_out.png', (err) => {
        if (err) console.error('Write Erro:', err);
        else console.log('Write Sucesso!');
    });

    // Timeout para não ficar preso
    setTimeout(() => {
        console.log('Timeout! Encerrando teste.');
        process.exit(0);
    }, 3000);
}

test();

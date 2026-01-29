import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Jimp } = require('jimp');

console.log('Testando new Jimp(w, h)...');
try {
    const img = new Jimp(100, 100);
    console.log('✅ new Jimp(w, h) funcionou!');
} catch (e) {
    console.log('❌ new Jimp(w, h) falhou:', e.message);
}

console.log('\nTestando new Jimp({ width: w, height: h })...');
try {
    const img = new Jimp({ width: 100, height: 100 });
    console.log('✅ new Jimp({ w, h }) funcionou!');
} catch (e) {
    console.log('❌ new Jimp({ w, h }) falhou:', e.message);
}

console.log('\nTestando new Jimp({ data: ..., width: w, height: h })...');
try {
    // Mock de buffer vazio
    const img = new Jimp({ data: Buffer.alloc(100 * 100 * 4), width: 100, height: 100 });
    console.log('✅ new Jimp({ data, w, h }) funcionou!');
} catch (e) {
    console.log('❌ new Jimp({ data, w, h }) falhou:', e.message);
}

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

try {
    const jimpModule = require('jimp');
    console.log('Tipo de exportação:', typeof jimpModule);
    console.log('Chaves exportadas:', Object.keys(jimpModule));
    console.log('É construtor?', typeof jimpModule === 'function');

    // Tentar instanciar baseando-se no que acharmos
    if (typeof jimpModule === 'function') {
        new jimpModule(10, 10);
        console.log('Sucesso: Jimp é o export principal');
    } else if (jimpModule.Jimp) {
        new jimpModule.Jimp(10, 10);
        console.log('Sucesso: Jimp está dentro de .Jimp');
    } else {
        console.log('Falha: Estrutura desconhecida');
    }

} catch (error) {
    console.error('Erro inspecionando Jimp:', error);
}

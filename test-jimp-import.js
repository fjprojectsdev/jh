import { Jimp } from 'jimp';

console.log('Jimp importado com sucesso:', Jimp);

try {
    const img = new Jimp(100, 100);
    console.log('Instância criada com sucesso');
} catch (error) {
    console.error('Erro ao instanciar Jimp:', error);
}

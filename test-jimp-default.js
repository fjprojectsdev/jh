import Jimp from 'jimp';

console.log('Jimp Default importado:', Jimp);

try {
    // Teste básico de criação (mockado ou real se possível sem IO)
    // Jimp v1 geralmente usa callbacks ou promises, o construtor new Jimp(w, h, cb) funciona
    new Jimp(100, 100, (err, image) => {
        if (err) console.error('Erro no callback:', err);
        else console.log('Imagem criada com sucesso via Default Export');
    });
} catch (error) {
    console.error('Erro ao instanciar Jimp Default:', error);
}


import * as JimpAll from 'jimp';
console.log('Keys of Jimp export:', Object.keys(JimpAll));
try {
    console.log('JimpAll.default:', JimpAll.default);
} catch (e) {
    console.log('No default export');
}
try {
    console.log('JimpAll.Jimp:', JimpAll.Jimp);
} catch (e) {
    console.log('No Jimp export');
}

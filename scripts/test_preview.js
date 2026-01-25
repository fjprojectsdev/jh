
import { extractFirstUrl, buildLinkPreview } from '../functions/linkPreview.js';

async function test() {
    console.log('--- Test Extract ---');
    console.log(extractFirstUrl('Olá visite https://google.com'));
    console.log(extractFirstUrl('Sem link'));
    console.log(extractFirstUrl('Check this: https://chat.whatsapp.com/invite/123'));

    console.log('\n--- Test Preview Google ---');
    const p1 = await buildLinkPreview('https://www.google.com');
    console.log('Google:', p1 ? { ...p1, jpegThumbnail: p1.jpegThumbnail ? `<Buffer ${p1.jpegThumbnail.length}>` : null } : 'null');

    console.log('\n--- Test Preview WhatsApp ---');
    const p2 = await buildLinkPreview('https://chat.whatsapp.com/invite/123');
    console.log('WhatsApp:', p2 ? { ...p2, jpegThumbnail: p2.jpegThumbnail ? `<Buffer ${p2.jpegThumbnail.length}>` : null } : 'null');
}

test();

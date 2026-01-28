console.log("🌟 [ENTRYPOINT] Iniciando wrapper de debug...");
console.log("🌟 [ENTRYPOINT] Node Version:", process.version);
console.log("🌟 [ENTRYPOINT] Platform:", process.platform);

async function start() {
    try {
        console.log("🌟 [ENTRYPOINT] Importando index.js...");
        await import('./index.js');
        console.log("🌟 [ENTRYPOINT] index.js importado com sucesso.");
    } catch (error) {
        console.error("❌ [FATAL ERROR] Falha ao importar index.js:");
        console.error(error);
        console.error(error.message);
        if (error.code) console.error("Code:", error.code);
        if (error.stack) console.error("Stack:", error.stack);
        process.exit(1);
    }
}

start();

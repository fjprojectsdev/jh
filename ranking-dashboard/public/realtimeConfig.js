(function attachRealtimeConfig(global) {
    const runtimeConfig = global.__IMAVY_RUNTIME_CONFIG__ || {};
    const config = {
        supabaseUrl: runtimeConfig.supabaseUrl || global.IMAVY_SUPABASE_URL || '',
        supabaseAnonKey: runtimeConfig.supabaseAnonKey || global.IMAVY_SUPABASE_ANON_KEY || '',
        tableName: runtimeConfig.tableName || global.IMAVY_REALTIME_TABLE || 'interacoes_texto'
    };

    global.ImavyRealtimeConfig = Object.freeze(config);
})(window);

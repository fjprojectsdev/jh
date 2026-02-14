(function attachRealtimeConfig(global) {
    const runtimeConfig = global.__IMAVY_RUNTIME_CONFIG__ || {};
    const config = {
        supabaseUrl: runtimeConfig.supabaseUrl || global.IMAVY_SUPABASE_URL || 'https://rarfoduchogogplyeevu.supabase.co',
        supabaseAnonKey: runtimeConfig.supabaseAnonKey || global.IMAVY_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhcmZvZHVjaG9nb2dwbHllZXZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwNzMyNzYsImV4cCI6MjA4NjY0OTI3Nn0.w60fAq8ieKr0s0O_Yapuosfrsu-Cpzm-5XroXXuj_Ig',
        tableName: runtimeConfig.tableName || global.IMAVY_REALTIME_TABLE || 'interacoes_texto'
    };

    global.ImavyRealtimeConfig = Object.freeze(config);
})(window);

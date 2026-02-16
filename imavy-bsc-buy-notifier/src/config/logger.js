function createLogger(level = 'info') {
    const priorities = {
        fatal: 0,
        error: 1,
        warn: 2,
        info: 3,
        debug: 4
    };

    const currentPriority = priorities[level] !== undefined ? priorities[level] : priorities.info;

    function emit(tag, message, meta) {
        const payload = {
            ts: new Date().toISOString(),
            level: tag,
            msg: message
        };

        if (meta !== undefined) {
            payload.meta = meta;
        }

        const line = JSON.stringify(payload);
        if (tag === 'error' || tag === 'fatal') {
            console.error(line);
            return;
        }

        console.log(line);
    }

    function canLog(tag) {
        const target = priorities[tag];
        if (target === undefined) {
            return false;
        }
        return target <= currentPriority;
    }

    return {
        fatal(message, meta) {
            if (canLog('fatal')) emit('fatal', message, meta);
        },
        error(message, meta) {
            if (canLog('error')) emit('error', message, meta);
        },
        warn(message, meta) {
            if (canLog('warn')) emit('warn', message, meta);
        },
        info(message, meta) {
            if (canLog('info')) emit('info', message, meta);
        },
        debug(message, meta) {
            if (canLog('debug')) emit('debug', message, meta);
        }
    };
}

module.exports = {
    createLogger
};

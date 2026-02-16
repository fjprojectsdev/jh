class DedupFilter {
    constructor(ttlMs, logger) {
        this.ttlMs = Number(ttlMs) || (24 * 60 * 60 * 1_000);
        this.logger = logger;
        this.store = new Map();
        this.cleanupTimer = null;
    }

    start() {
        if (this.cleanupTimer) {
            return;
        }

        const intervalMs = Math.max(30_000, Math.floor(this.ttlMs / 6));
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpired();
        }, intervalMs);

        if (typeof this.cleanupTimer.unref === 'function') {
            this.cleanupTimer.unref();
        }
    }

    stop() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    cleanupExpired() {
        const now = Date.now();
        let deleted = 0;

        for (const [key, expireAt] of this.store.entries()) {
            if (expireAt <= now) {
                this.store.delete(key);
                deleted += 1;
            }
        }

        if (deleted > 0 && this.logger) {
            this.logger.debug('Dedup cleanup executado.', { removidos: deleted, restante: this.store.size });
        }
    }

    has(key) {
        const expireAt = this.store.get(key);
        if (!expireAt) {
            return false;
        }

        if (expireAt <= Date.now()) {
            this.store.delete(key);
            return false;
        }

        return true;
    }

    mark(key) {
        const expireAt = Date.now() + this.ttlMs;
        this.store.set(key, expireAt);
    }

    isDuplicateAndMark(key) {
        if (this.has(key)) {
            return true;
        }

        this.mark(key);
        return false;
    }
}

module.exports = {
    DedupFilter
};

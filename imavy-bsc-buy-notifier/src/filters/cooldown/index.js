class CooldownFilter {
    constructor(cooldownMs) {
        this.cooldownMs = Number(cooldownMs) || 8_000;
        this.untilByKey = new Map();
    }

    isInCooldown(key) {
        const safeKey = String(key || '').trim().toLowerCase();
        if (!safeKey) {
            return false;
        }

        const until = this.untilByKey.get(safeKey);
        if (!until) {
            return false;
        }

        if (until <= Date.now()) {
            this.untilByKey.delete(safeKey);
            return false;
        }

        return true;
    }

    hit(key) {
        const safeKey = String(key || '').trim().toLowerCase();
        if (!safeKey) {
            return;
        }

        this.untilByKey.set(safeKey, Date.now() + this.cooldownMs);
    }

    isInCooldownAndHit(key) {
        if (this.isInCooldown(key)) {
            return true;
        }

        this.hit(key);
        return false;
    }
}

module.exports = {
    CooldownFilter
};

class BnbUsdPriceService {
    constructor({ url, refreshMs, logger }) {
        this.url = url;
        this.refreshMs = Number(refreshMs) || 60_000;
        this.logger = logger;
        this.currentPrice = null;
        this.updatedAt = null;
        this.timer = null;
    }

    parsePrice(payload) {
        const raw = payload && payload.price;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('Resposta de preco invalida.');
        }
        return parsed;
    }

    async refresh() {
        const response = await fetch(this.url, { method: 'GET' });
        if (!response.ok) {
            throw new Error(`Falha ao buscar preco BNB (HTTP ${response.status}).`);
        }

        const body = await response.json();
        const price = this.parsePrice(body);
        this.currentPrice = price;
        this.updatedAt = new Date();
        if (this.logger) {
            this.logger.debug('Preco BNB atualizado.', {
                price,
                updatedAt: this.updatedAt.toISOString()
            });
        }
        return price;
    }

    async start() {
        await this.refresh();

        if (this.timer) {
            clearInterval(this.timer);
        }

        this.timer = setInterval(async () => {
            try {
                await this.refresh();
            } catch (error) {
                if (this.logger) {
                    this.logger.warn('Falha ao atualizar preco BNB.', { error: error.message });
                }
            }
        }, this.refreshMs);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    getPrice() {
        return this.currentPrice;
    }

    getSnapshot() {
        return {
            price: this.currentPrice,
            updatedAt: this.updatedAt ? this.updatedAt.toISOString() : null
        };
    }
}

module.exports = {
    BnbUsdPriceService
};

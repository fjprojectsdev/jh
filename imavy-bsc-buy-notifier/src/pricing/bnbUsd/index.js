class BnbUsdPriceService {
    constructor({ url, urls, refreshMs, logger, label = 'preco' }) {
        const candidateUrls = Array.isArray(urls) ? urls : [url];
        this.urls = candidateUrls
            .map((item) => String(item || '').trim())
            .filter(Boolean);
        this.refreshMs = Number(refreshMs) || 60_000;
        this.logger = logger;
        this.label = String(label || 'preco');
        this.currentPrice = null;
        this.updatedAt = null;
        this.timer = null;
    }

    parsePrice(payload) {
        const candidates = [
            payload && payload.price,
            payload && payload.bid,
            payload && payload.ask,
            payload && payload?.tether?.brl,
            payload && payload?.tether?.usd,
            payload && payload?.USDBRL?.bid,
            payload && payload?.USDTBRL?.bid,
            Array.isArray(payload) ? payload[0]?.price : undefined
        ];

        const raw = candidates.find((value) => value !== undefined && value !== null && value !== '');
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('Resposta de preco invalida.');
        }
        return parsed;
    }

    async refresh() {
        if (!this.urls.length) {
            throw new Error(`Nenhuma URL configurada para ${this.label}.`);
        }

        let lastError = null;

        for (const url of this.urls) {
            try {
                const response = await fetch(url, { method: 'GET' });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const body = await response.json();
                const price = this.parsePrice(body);
                this.currentPrice = price;
                this.updatedAt = new Date();
                if (this.logger) {
                    this.logger.debug(`${this.label} atualizado.`, {
                        price,
                        updatedAt: this.updatedAt.toISOString(),
                        url
                    });
                }
                return price;
            } catch (error) {
                lastError = error;
                if (this.logger) {
                    this.logger.warn(`Falha ao buscar ${this.label} em endpoint.`, {
                        url,
                        error: error.message
                    });
                }
            }
        }

        throw lastError || new Error(`Falha ao atualizar ${this.label}.`);
    }

    async start(options = {}) {
        const { tolerateInitialFailure = false } = options;
        try {
            await this.refresh();
        } catch (error) {
            if (!tolerateInitialFailure) {
                throw error;
            }

            if (this.logger) {
                this.logger.warn(`Inicializacao sem valor inicial para ${this.label}.`, {
                    error: error.message
                });
            }
        }

        if (this.timer) {
            clearInterval(this.timer);
        }

        this.timer = setInterval(async () => {
            try {
                await this.refresh();
            } catch (error) {
                if (this.logger) {
                    this.logger.warn(`Falha ao atualizar ${this.label}.`, { error: error.message });
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

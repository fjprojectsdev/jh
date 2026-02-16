class MevFilter {
    constructor({ provider, swapTopic, enabled, maxSwapLogsPerTx, logger }) {
        this.provider = provider;
        this.swapTopic = String(swapTopic || '').toLowerCase();
        this.enabled = Boolean(enabled);
        this.maxSwapLogsPerTx = Number(maxSwapLogsPerTx) || 3;
        this.logger = logger;
    }

    async isSuspicious(txHash) {
        if (!this.enabled) {
            return false;
        }

        try {
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (!receipt || !Array.isArray(receipt.logs)) {
                return false;
            }

            let swapCount = 0;
            for (const log of receipt.logs) {
                const topic0 = log && Array.isArray(log.topics) ? String(log.topics[0] || '').toLowerCase() : '';
                if (topic0 === this.swapTopic) {
                    swapCount += 1;
                }
            }

            return swapCount > this.maxSwapLogsPerTx;
        } catch (error) {
            if (this.logger) {
                this.logger.warn('Falha ao aplicar filtro MEV. Transacao sera tratada como nao suspeita.', {
                    txHash,
                    error: error.message
                });
            }
            return false;
        }
    }
}

module.exports = {
    MevFilter
};

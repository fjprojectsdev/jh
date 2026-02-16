const { Contract, Interface, getAddress, id, formatUnits } = require('ethers');

const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)'
];

const ERC20_ABI = [
    'function decimals() view returns (uint8)'
];

const SWAP_TOPIC = id('Swap(address,uint256,uint256,uint256,uint256,address)');

class BuyDetector {
    constructor({ tokenConfig, wbnbAddress, logger }) {
        this.symbol = tokenConfig.symbol;
        this.pair = getAddress(tokenConfig.pair);
        this.token = getAddress(tokenConfig.token);
        this.wbnb = getAddress(wbnbAddress);
        this.logger = logger;

        this.swapInterface = new Interface(PAIR_ABI);
        this.mode = null;
        this.tokenDecimals = 18;
        this.ready = false;
    }

    static getSwapTopic() {
        return SWAP_TOPIC;
    }

    async initialize(provider) {
        const pairContract = new Contract(this.pair, PAIR_ABI, provider);
        const [token0Raw, token1Raw] = await Promise.all([
            pairContract.token0(),
            pairContract.token1()
        ]);

        const token0 = getAddress(token0Raw);
        const token1 = getAddress(token1Raw);

        if (token0 === this.wbnb && token1 === this.token) {
            this.mode = 'TOKEN1_IS_TARGET_WBNB_IN_TOKEN0';
        } else if (token1 === this.wbnb && token0 === this.token) {
            this.mode = 'TOKEN0_IS_TARGET_WBNB_IN_TOKEN1';
        } else {
            throw new Error(
                `Par ${this.symbol} nao contem combinacao valida WBNB/TOKEN. token0=${token0}, token1=${token1}`
            );
        }

        try {
            const tokenContract = new Contract(this.token, ERC20_ABI, provider);
            const decimals = await tokenContract.decimals();
            const parsedDecimals = Number(decimals);
            if (Number.isFinite(parsedDecimals) && parsedDecimals >= 0 && parsedDecimals <= 36) {
                this.tokenDecimals = parsedDecimals;
            }
        } catch (error) {
            if (this.logger) {
                this.logger.warn('Falha ao buscar decimals do token. Usando 18.', {
                    symbol: this.symbol,
                    token: this.token,
                    error: error.message
                });
            }
        }

        this.ready = true;

        if (this.logger) {
            this.logger.info('Buy detector inicializado.', {
                symbol: this.symbol,
                pair: this.pair,
                token: this.token,
                mode: this.mode,
                tokenDecimals: this.tokenDecimals
            });
        }
    }

    parseSwapLog(log) {
        return this.swapInterface.parseLog({
            data: log.data,
            topics: log.topics
        });
    }

    detectBuyFromLog(log) {
        if (!this.ready) {
            return null;
        }

        try {
            const parsed = this.parseSwapLog(log);
            if (!parsed || !parsed.args) {
                return null;
            }

            const amount0In = parsed.args.amount0In;
            const amount1In = parsed.args.amount1In;
            const amount0Out = parsed.args.amount0Out;
            const amount1Out = parsed.args.amount1Out;

            let isBuy = false;
            let bnbInRaw = 0n;
            let tokenOutRaw = 0n;

            if (this.mode === 'TOKEN1_IS_TARGET_WBNB_IN_TOKEN0') {
                isBuy = amount0In > 0n && amount1Out > 0n;
                bnbInRaw = amount0In;
                tokenOutRaw = amount1Out;
            } else if (this.mode === 'TOKEN0_IS_TARGET_WBNB_IN_TOKEN1') {
                isBuy = amount1In > 0n && amount0Out > 0n;
                bnbInRaw = amount1In;
                tokenOutRaw = amount0Out;
            }

            if (!isBuy) {
                return null;
            }

            return {
                symbol: this.symbol,
                pair: this.pair,
                token: this.token,
                txHash: log.transactionHash,
                logIndex: Number(log.index ?? log.logIndex ?? 0),
                blockNumber: Number(log.blockNumber),
                to: parsed.args.to,
                bnbInRaw,
                tokenOutRaw,
                bnbIn: Number(formatUnits(bnbInRaw, 18)),
                tokenOut: Number(formatUnits(tokenOutRaw, this.tokenDecimals))
            };
        } catch (_) {
            return null;
        }
    }
}

module.exports = {
    BuyDetector
};

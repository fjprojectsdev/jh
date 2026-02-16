const { getAddress } = require('ethers');

const WBNB = getAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');

const TOKENS = [
    {
        symbol: 'NIX',
        pair: getAddress('0x7f01f344b1950a3C5EA3B9dB7017f93aB0c8f88E'),
        token: getAddress('0xbe96fcf736ad906b1821ef74a0e4e346c74e6221')
    },
    {
        symbol: 'SNAP',
        pair: getAddress('0x7646C457a2C4d260f678F3126Fa41e20BFdD1F95'),
        token: getAddress('0x3a9e15b28e099708d0812e0843a9ed70c508fb4b')
    }
];

module.exports = {
    WBNB,
    TOKENS
};

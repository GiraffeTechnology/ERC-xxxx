require("@nomicfoundation/hardhat-ethers");

module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true
    }
  },
  paths: {
    sources: "./interfaces",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};

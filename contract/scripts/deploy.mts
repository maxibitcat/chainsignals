import { network } from "hardhat";

async function main() {
    const { ethers } = await network.connect();
    const [signer] = await ethers.getSigners();

    console.log("Deploying from:", await signer.getAddress());

    // Show current gas price
    const gasPriceHex = await ethers.provider.send("eth_gasPrice", []);
    const gasPrice = BigInt(gasPriceHex);
    console.log("Current gas price (wei):", gasPrice.toString());

    const factory = await ethers.getContractFactory("ChainSignals", signer);

    // Optionally: override gas price manually
    const contract = await factory.deploy({
        gasPrice,                     // use node's suggestion
        // gasPrice: BigInt("1000000000"), // 1 gwei for example
    });

    console.log("Deployment tx hash:", contract.deploymentTransaction()?.hash);
    await contract.waitForDeployment();
    console.log("ChainSignals deployed to:", await contract.getAddress());
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

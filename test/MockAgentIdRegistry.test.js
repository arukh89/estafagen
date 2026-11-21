const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("MockAgentIdRegistry", function () {
  async function deployRegistryFixture() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("MockAgentIdRegistry");
    const registry = await Registry.deploy();
    return { registry, deployer, alice, bob };
  }

  it("returns 0 by default for any address", async function () {
    const { registry, alice, bob } = await loadFixture(deployRegistryFixture);
    expect(await registry.balanceOf(alice.address)).to.equal(0);
    expect(await registry.balanceOf(bob.address)).to.equal(0);
  });

  it("setBalance makes balanceOf reflect the mocked holding", async function () {
    const { registry, alice } = await loadFixture(deployRegistryFixture);
    await registry.setBalance(alice.address, 1);
    expect(await registry.balanceOf(alice.address)).to.equal(1);
  });

  it("balances are independent per address", async function () {
    const { registry, alice, bob } = await loadFixture(deployRegistryFixture);
    await registry.setBalance(alice.address, 1);
    await registry.setBalance(bob.address, 2);
    expect(await registry.balanceOf(alice.address)).to.equal(1);
    expect(await registry.balanceOf(bob.address)).to.equal(2);
  });

  it("setBalance can revoke holder status by setting 0", async function () {
    const { registry, alice } = await loadFixture(deployRegistryFixture);
    await registry.setBalance(alice.address, 1);
    expect(await registry.balanceOf(alice.address)).to.equal(1);
    await registry.setBalance(alice.address, 0);
    expect(await registry.balanceOf(alice.address)).to.equal(0);
  });
});

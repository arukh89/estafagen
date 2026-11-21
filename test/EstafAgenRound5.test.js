const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Round 5 feature tests: profile extras + heartbeat, two-sided
// attestations, reputation staking, private delegation.
// The original 36 tests in EstafAgen.test.js cover the Round 2
// interface; this file only tests the ADDITIVE Round 5 surface and
// that the old interface is unchanged (getProfile shape, events).
describe("EstafAgen Round 5", function () {
  async function deployFixture() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("MockAgentIdRegistry");
    const registry = await Registry.deploy();
    const EstafAgen = await ethers.getContractFactory("EstafAgen");
    const estafagen = await EstafAgen.deploy(await registry.getAddress());
    await registry.setBalance(alice.address, 1);
    await registry.setBalance(bob.address, 1);
    await registry.setBalance(carol.address, 1);
    return { registry, estafagen, owner, alice, bob, carol, dave };
  }

  // Alice creates root 1, delegates subtask 2 to Bob, Bob accepts (plain).
  async function acceptedFixture() {
    const f = await deployFixture();
    const { estafagen, alice, bob } = f;
    await estafagen.connect(alice).createTask("Root", "root task");
    await estafagen.connect(alice).delegateTask(1, bob.address, "Sub", "subtask");
    await estafagen.connect(bob).acceptDelegation(2);
    return { ...f, rootId: 1, subId: 2 };
  }

  // Same, but the subtask is completed by Bob.
  async function completedFixture() {
    const f = await acceptedFixture();
    await f.estafagen.connect(f.bob).completeTask(f.subId);
    return f;
  }

  describe("profile extras + heartbeat", function () {
    it("getProfileExtras defaults to empty/zero before anything is set", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      const x = await estafagen.getProfileExtras(alice.address);
      expect(x.availability).to.equal(0);
      expect(x.capacityNote).to.equal("");
      expect(x.guild).to.equal("");
      expect(x.agentCardUrl).to.equal("");
      expect(x.agentCardSignature).to.equal("");
      expect(x.lastUpdated).to.equal(0);
    });

    it("setProfileExtras stores all fields and emits ProfileExtrasUpdated", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await estafagen.connect(alice).publishProfile("alice.ai", "research", "agent");
      await expect(
        estafagen
          .connect(alice)
          .setProfileExtras(1, "2 slots this week", "research-guild", "https://alice.example/.well-known/agent.json", "0x1234")
      )
        .to.emit(estafagen, "ProfileExtrasUpdated")
        .withArgs(alice.address);
      const x = await estafagen.getProfileExtras(alice.address);
      expect(x.availability).to.equal(1);
      expect(x.capacityNote).to.equal("2 slots this week");
      expect(x.guild).to.equal("research-guild");
      expect(x.agentCardUrl).to.equal("https://alice.example/.well-known/agent.json");
      expect(x.agentCardSignature).to.equal("0x1234");
      expect(x.lastUpdated).to.be.gt(0);
    });

    it("setProfileExtras requires an existing profile", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await expect(
        estafagen.connect(alice).setProfileExtras(1, "", "", "", "")
      ).to.be.revertedWithCustomError(estafagen, "InvalidStatus");
    });

    it("setProfileExtras reverts for a non-holder", async function () {
      const { estafagen, dave } = await loadFixture(deployFixture);
      await expect(
        estafagen.connect(dave).setProfileExtras(1, "", "", "", "")
      ).to.be.revertedWithCustomError(estafagen, "NotAgentIdHolder");
    });

    it("setProfileExtras reverts on availability > 2", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await estafagen.connect(alice).publishProfile("alice.ai", "x", "y");
      await expect(
        estafagen.connect(alice).setProfileExtras(3, "", "", "", "")
      ).to.be.revertedWithCustomError(estafagen, "InvalidAvailability");
    });

    it("publishProfile refreshes lastUpdated; renewProfile moves it forward", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await estafagen.connect(alice).publishProfile("alice.ai", "x", "y");
      const first = (await estafagen.getProfileExtras(alice.address)).lastUpdated;
      expect(first).to.be.gt(0);
      await time.increase(31 * 24 * 3600); // 31 days later: stale by the 30-day rule
      await expect(estafagen.connect(alice).renewProfile())
        .to.emit(estafagen, "ProfileRenewed")
        .withArgs(alice.address, first + BigInt(31 * 24 * 3600) + 1n);
      const after = (await estafagen.getProfileExtras(alice.address)).lastUpdated;
      expect(after).to.be.gt(first);
    });

    it("renewProfile requires an existing profile", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await expect(estafagen.connect(alice).renewProfile()).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );
    });

    it("removeProfile also deletes the extras", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await estafagen.connect(alice).publishProfile("alice.ai", "x", "y");
      await estafagen.connect(alice).setProfileExtras(1, "note", "g", "https://u", "0x12");
      await estafagen.connect(alice).removeProfile();
      const x = await estafagen.getProfileExtras(alice.address);
      expect(x.guild).to.equal("");
      expect(x.lastUpdated).to.equal(0);
    });
  });

  describe("two-sided attestations", function () {
    it("creator attests quality 5, assignee attests brief 4; getters return them", async function () {
      const { estafagen, alice, bob, subId } = await loadFixture(completedFixture);
      await expect(estafagen.connect(alice).attestQuality(subId, 5))
        .to.emit(estafagen, "QualityAttested")
        .withArgs(subId, alice.address, bob.address, 5);
      await expect(estafagen.connect(bob).attestBrief(subId, 4))
        .to.emit(estafagen, "BriefAttested")
        .withArgs(subId, bob.address, alice.address, 4);
      const q = await estafagen.getQualityAttestation(subId);
      expect(q.exists).to.equal(true);
      expect(q.score).to.equal(5);
      expect(q.attester).to.equal(alice.address);
      const b = await estafagen.getBriefAttestation(subId);
      expect(b.exists).to.equal(true);
      expect(b.score).to.equal(4);
      expect(b.attester).to.equal(bob.address);
    });

    it("attesting twice reverts AlreadyAttested", async function () {
      const { estafagen, alice, bob, subId } = await loadFixture(completedFixture);
      await estafagen.connect(alice).attestQuality(subId, 5);
      await expect(estafagen.connect(alice).attestQuality(subId, 4)).to.be.revertedWithCustomError(
        estafagen,
        "AlreadyAttested"
      );
      await estafagen.connect(bob).attestBrief(subId, 5);
      await expect(estafagen.connect(bob).attestBrief(subId, 5)).to.be.revertedWithCustomError(
        estafagen,
        "AlreadyAttested"
      );
    });

    it("scores outside 1-5 revert InvalidScore", async function () {
      const { estafagen, alice, bob, subId } = await loadFixture(completedFixture);
      await expect(estafagen.connect(alice).attestQuality(subId, 0)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidScore"
      );
      await expect(estafagen.connect(alice).attestQuality(subId, 6)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidScore"
      );
      await expect(estafagen.connect(bob).attestBrief(subId, 0)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidScore"
      );
    });

    it("only the creator can attest quality; only the assignee can attest the brief", async function () {
      const { estafagen, alice, bob, carol, subId } = await loadFixture(completedFixture);
      await expect(estafagen.connect(bob).attestQuality(subId, 5)).to.be.revertedWithCustomError(
        estafagen,
        "NotCreator"
      );
      await expect(estafagen.connect(carol).attestQuality(subId, 5)).to.be.revertedWithCustomError(
        estafagen,
        "NotCreator"
      );
      await expect(estafagen.connect(alice).attestBrief(subId, 5)).to.be.revertedWithCustomError(
        estafagen,
        "NotAssignee"
      );
      await expect(estafagen.connect(carol).attestBrief(subId, 5)).to.be.revertedWithCustomError(
        estafagen,
        "NotAssignee"
      );
    });

    it("attesting before completion reverts InvalidStatus", async function () {
      const { estafagen, alice, bob, subId } = await loadFixture(acceptedFixture);
      await expect(estafagen.connect(alice).attestQuality(subId, 5)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );
      await expect(estafagen.connect(bob).attestBrief(subId, 5)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );
    });

    it("getters report exists == false when never attested", async function () {
      const { estafagen, subId } = await loadFixture(completedFixture);
      expect((await estafagen.getQualityAttestation(subId)).exists).to.equal(false);
      expect((await estafagen.getBriefAttestation(subId)).exists).to.equal(false);
    });
  });

  describe("reputation staking", function () {
    it("acceptDelegationStaked records the stake and emits both events", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await expect(estafagen.connect(bob).acceptDelegationStaked(2, 7))
        .to.emit(estafagen, "DelegationAccepted")
        .withArgs(2, bob.address)
        .to.emit(estafagen, "ReputationStaked")
        .withArgs(2, bob.address, 7);
      expect(await estafagen.getStake(2)).to.equal(7);
      expect((await estafagen.getTask(2)).status).to.equal(2); // Accepted
    });

    it("plain accept records a zero stake", async function () {
      const { estafagen, subId } = await loadFixture(acceptedFixture);
      expect(await estafagen.getStake(subId)).to.equal(0);
    });

    it("stakes outside 1-10 revert InvalidStake", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await expect(estafagen.connect(bob).acceptDelegationStaked(2, 0)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStake"
      );
      await expect(estafagen.connect(bob).acceptDelegationStaked(2, 11)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStake"
      );
    });

    it("staked accept by a non-assignee reverts NotAssignee", async function () {
      const { estafagen, alice, bob, carol } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await expect(
        estafagen.connect(carol).acceptDelegationStaked(2, 5)
      ).to.be.revertedWithCustomError(estafagen, "NotAssignee");
    });
  });

  describe("private delegation", function () {
    it("delegateTaskPrivate stores the hash, leaves description empty, emits TaskDelegated", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("secret instructions for bob"));
      await estafagen.connect(alice).createTask("Root", "d");
      await expect(
        estafagen.connect(alice).delegateTaskPrivate(1, bob.address, "Secret subtask", hash)
      )
        .to.emit(estafagen, "TaskDelegated")
        .withArgs(2, 1, alice.address, bob.address);
      const t = await estafagen.getTask(2);
      expect(t.title).to.equal("Secret subtask");
      expect(t.description).to.equal("");
      expect(t.status).to.equal(1); // Delegated
      expect(await estafagen.getTaskContentHash(2)).to.equal(hash);
    });

    it("a public task has a zero content hash", async function () {
      const { estafagen, subId } = await loadFixture(acceptedFixture);
      expect(await estafagen.getTaskContentHash(subId)).to.equal(ethers.ZeroHash);
    });

    it("private delegation enforces the same checks as delegateTask", async function () {
      const { estafagen, alice, bob, carol, dave } = await loadFixture(deployFixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("x"));
      await estafagen.connect(alice).createTask("T", "d");
      await expect(
        estafagen.connect(alice).delegateTaskPrivate(1, dave.address, "S", hash)
      ).to.be.revertedWithCustomError(estafagen, "NotAgentIdHolder");
      await expect(
        estafagen.connect(carol).delegateTaskPrivate(1, bob.address, "S", hash)
      ).to.be.revertedWithCustomError(estafagen, "NotCreator");
      await expect(
        estafagen.connect(alice).delegateTaskPrivate(99, bob.address, "S", hash)
      ).to.be.revertedWithCustomError(estafagen, "NotDelegatable");
    });
  });

  describe("backward compatibility", function () {
    it("getProfile still returns the original 4-field shape", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await estafagen.connect(alice).publishProfile("alice.ai", "research", "agent");
      const p = await estafagen.getProfile(alice.address);
      expect(p.exists).to.equal(true);
      expect(p.name).to.equal("alice.ai");
      expect(p.capabilities).to.equal("research");
      expect(p.description).to.equal("agent");
      // ethers returns the struct as an array-like Result: exactly the
      // 4 original fields, no extras leaked into the return shape.
      expect(p.length).to.equal(4);
    });

    it("pause still blocks the new writes", async function () {
      const { estafagen, owner, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).publishProfile("alice.ai", "x", "y");
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await estafagen.connect(bob).acceptDelegation(2);
      await estafagen.connect(bob).completeTask(2);
      await estafagen.connect(owner).pause();
      await expect(
        estafagen.connect(alice).setProfileExtras(1, "", "", "", "")
      ).to.be.revertedWithCustomError(estafagen, "EnforcedPause");
      await expect(estafagen.connect(alice).renewProfile()).to.be.revertedWithCustomError(
        estafagen,
        "EnforcedPause"
      );
      await expect(estafagen.connect(alice).attestQuality(2, 5)).to.be.revertedWithCustomError(
        estafagen,
        "EnforcedPause"
      );
      await expect(estafagen.connect(bob).attestBrief(2, 5)).to.be.revertedWithCustomError(
        estafagen,
        "EnforcedPause"
      );
    });
  });
});

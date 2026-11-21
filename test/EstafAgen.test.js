const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Status enum order in EstafAgen.sol:
// Open = 0, Delegated = 1, Accepted = 2, Completed = 3, Rejected = 4, Cancelled = 5
const Status = {
  Open: 0,
  Delegated: 1,
  Accepted: 2,
  Completed: 3,
  Rejected: 4,
  Cancelled: 5,
};

describe("EstafAgen", function () {
  async function deployFixture() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("MockAgentIdRegistry");
    const registry = await Registry.deploy();
    const EstafAgen = await ethers.getContractFactory("EstafAgen");
    const estafagen = await EstafAgen.deploy(await registry.getAddress());
    // alice, bob, carol hold an Agent ID; dave stays a non-holder.
    await registry.setBalance(alice.address, 1);
    await registry.setBalance(bob.address, 1);
    await registry.setBalance(carol.address, 1);
    return { registry, estafagen, owner, alice, bob, carol, dave };
  }

  // alice creates root task 1, delegates subtask 2 to bob, bob accepts it.
  async function acceptedChainFixture() {
    const f = await deployFixture();
    const { estafagen, alice, bob } = f;
    await estafagen.connect(alice).createTask("Root", "root task");
    await estafagen.connect(alice).delegateTask(1, bob.address, "Sub", "subtask");
    await estafagen.connect(bob).acceptDelegation(2);
    return { ...f, rootId: 1, subId: 2 };
  }

  describe("deployment", function () {
    it("stores the registry address and sets the deployer as owner", async function () {
      const { registry, estafagen, owner } = await loadFixture(deployFixture);
      expect(await estafagen.agentIdRegistry()).to.equal(await registry.getAddress());
      expect(await estafagen.owner()).to.equal(owner.address);
      expect(await estafagen.paused()).to.equal(false);
    });

    it("reverts on a zero registry address", async function () {
      const EstafAgen = await ethers.getContractFactory("EstafAgen");
      await expect(EstafAgen.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        EstafAgen,
        "InvalidRegistryAddress"
      );
    });

    it("isHolder reflects the registry balance", async function () {
      const { estafagen, alice, dave } = await loadFixture(deployFixture);
      expect(await estafagen.isHolder(alice.address)).to.equal(true);
      expect(await estafagen.isHolder(dave.address)).to.equal(false);
    });
  });

  describe("holder gating", function () {
    it("non-holder cannot publish a profile", async function () {
      const { estafagen, dave } = await loadFixture(deployFixture);
      await expect(
        estafagen.connect(dave).publishProfile("dave.ai", "coding", "dev")
      ).to.be.revertedWithCustomError(estafagen, "NotAgentIdHolder");
    });

    it("non-holder cannot create a task", async function () {
      const { estafagen, dave } = await loadFixture(deployFixture);
      await expect(estafagen.connect(dave).createTask("T", "d")).to.be.revertedWithCustomError(
        estafagen,
        "NotAgentIdHolder"
      );
    });

    it("non-holder cannot delegate a task", async function () {
      const { estafagen, alice, bob, dave } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await expect(
        estafagen.connect(dave).delegateTask(1, bob.address, "S", "d")
      ).to.be.revertedWithCustomError(estafagen, "NotAgentIdHolder");
    });

    it("accepting after losing holder status reverts, and works again after restore", async function () {
      const { registry, estafagen, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await registry.setBalance(bob.address, 0);
      await expect(estafagen.connect(bob).acceptDelegation(2)).to.be.revertedWithCustomError(
        estafagen,
        "NotAgentIdHolder"
      );
      await registry.setBalance(bob.address, 1);
      await expect(estafagen.connect(bob).acceptDelegation(2))
        .to.emit(estafagen, "DelegationAccepted")
        .withArgs(2, bob.address);
    });
  });

  describe("profiles", function () {
    it("publishProfile stores the profile and emits ProfilePublished", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await expect(estafagen.connect(alice).publishProfile("alice.ai", "research, coding", "my agent"))
        .to.emit(estafagen, "ProfilePublished")
        .withArgs(alice.address, "alice.ai");
      expect(await estafagen.hasProfile(alice.address)).to.equal(true);
      const profile = await estafagen.getProfile(alice.address);
      expect(profile.exists).to.equal(true);
      expect(profile.name).to.equal("alice.ai");
      expect(profile.capabilities).to.equal("research, coding");
      expect(profile.description).to.equal("my agent");
    });

    it("publishProfile upserts: calling again replaces the profile", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await estafagen.connect(alice).publishProfile("alice.ai", "v1", "first");
      await estafagen.connect(alice).publishProfile("alice2.ai", "v2", "second");
      const profile = await estafagen.getProfile(alice.address);
      expect(profile.name).to.equal("alice2.ai");
      expect(profile.capabilities).to.equal("v2");
      expect(profile.description).to.equal("second");
    });

    it("removeProfile deletes the profile and emits ProfileRemoved", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await estafagen.connect(alice).publishProfile("alice.ai", "x", "y");
      await expect(estafagen.connect(alice).removeProfile())
        .to.emit(estafagen, "ProfileRemoved")
        .withArgs(alice.address);
      expect(await estafagen.hasProfile(alice.address)).to.equal(false);
      const profile = await estafagen.getProfile(alice.address);
      expect(profile.exists).to.equal(false);
      expect(profile.name).to.equal("");
    });

    it("removeProfile with no profile reverts InvalidStatus", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await expect(estafagen.connect(alice).removeProfile()).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );
    });

    it("getProfile of a never-published holder reports exists == false", async function () {
      const { estafagen, dave } = await loadFixture(deployFixture);
      const profile = await estafagen.getProfile(dave.address);
      expect(profile.exists).to.equal(false);
    });
  });

  describe("tasks: creation", function () {
    it("createTask makes a root task: assignee is creator, parentId 0, status Open", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await expect(estafagen.connect(alice).createTask("Root", "do the thing"))
        .to.emit(estafagen, "TaskCreated")
        .withArgs(1, alice.address);
      const task = await estafagen.getTask(1);
      expect(task.id).to.equal(1);
      expect(task.title).to.equal("Root");
      expect(task.creator).to.equal(alice.address);
      expect(task.assignee).to.equal(alice.address);
      expect(task.parentId).to.equal(0);
      expect(task.status).to.equal(Status.Open);
      expect(task.createdAt).to.be.gt(0);
      expect(await estafagen.taskCount()).to.equal(1);
    });

    it("getTask on a nonexistent id reverts InvalidStatus", async function () {
      const { estafagen } = await loadFixture(deployFixture);
      await expect(estafagen.getTask(0)).to.be.revertedWithCustomError(estafagen, "InvalidStatus");
      await expect(estafagen.getTask(99)).to.be.revertedWithCustomError(estafagen, "InvalidStatus");
    });
  });

  describe("tasks: full delegation chain", function () {
    it("create -> delegate -> accept -> complete, with events and state at each step", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);

      await estafagen.connect(alice).createTask("Root", "root task");

      await expect(estafagen.connect(alice).delegateTask(1, bob.address, "Sub", "subtask"))
        .to.emit(estafagen, "TaskDelegated")
        .withArgs(2, 1, alice.address, bob.address);
      let sub = await estafagen.getTask(2);
      expect(sub.creator).to.equal(alice.address);
      expect(sub.assignee).to.equal(bob.address);
      expect(sub.parentId).to.equal(1);
      expect(sub.status).to.equal(Status.Delegated);

      await expect(estafagen.connect(bob).acceptDelegation(2))
        .to.emit(estafagen, "DelegationAccepted")
        .withArgs(2, bob.address);
      sub = await estafagen.getTask(2);
      expect(sub.status).to.equal(Status.Accepted);

      await expect(estafagen.connect(bob).completeTask(2))
        .to.emit(estafagen, "TaskCompleted")
        .withArgs(2, bob.address);
      sub = await estafagen.getTask(2);
      expect(sub.status).to.equal(Status.Completed);
      expect(await estafagen.taskCount()).to.equal(2);
    });

    it("completing a subtask does NOT change the parent status (documented v1 limit)", async function () {
      const { estafagen, rootId, subId } = await loadFixture(acceptedChainFixture);
      const { bob } = await loadFixture(acceptedChainFixture);
      await estafagen.connect(bob).completeTask(subId);
      const root = await estafagen.getTask(rootId);
      expect(root.status).to.equal(Status.Open);
    });

    it("delegating to a holder without a profile works (profile is not required)", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      expect(await estafagen.hasProfile(bob.address)).to.equal(false);
      await estafagen.connect(alice).createTask("T", "d");
      await expect(estafagen.connect(alice).delegateTask(1, bob.address, "S", "d"))
        .to.emit(estafagen, "TaskDelegated")
        .withArgs(2, 1, alice.address, bob.address);
    });

    it("multi-level chain: assignee accepts, then delegates further to a third holder", async function () {
      const { estafagen, alice, bob, carol } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("Root", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "L1", "d");
      await estafagen.connect(bob).acceptDelegation(2);
      await expect(estafagen.connect(bob).delegateTask(2, carol.address, "L2", "d"))
        .to.emit(estafagen, "TaskDelegated")
        .withArgs(3, 2, bob.address, carol.address);
      await estafagen.connect(carol).acceptDelegation(3);
      await estafagen.connect(carol).completeTask(3);
      expect((await estafagen.getTask(3)).status).to.equal(Status.Completed);
      expect((await estafagen.getTask(2)).status).to.equal(Status.Accepted);
      expect((await estafagen.getTask(1)).status).to.equal(Status.Open);
    });
  });

  describe("tasks: reject and cancel paths", function () {
    it("reject path: delegate -> reject -> Rejected; accept/complete after reject revert", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await expect(estafagen.connect(bob).rejectDelegation(2))
        .to.emit(estafagen, "DelegationRejected")
        .withArgs(2, bob.address);
      expect((await estafagen.getTask(2)).status).to.equal(Status.Rejected);
      await expect(estafagen.connect(bob).acceptDelegation(2)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );
      await expect(estafagen.connect(bob).completeTask(2)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );
    });

    it("creator cancels an Open task; cancel on Completed or already-Cancelled reverts", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await expect(estafagen.connect(alice).cancelTask(1))
        .to.emit(estafagen, "TaskCancelled")
        .withArgs(1, alice.address);
      expect((await estafagen.getTask(1)).status).to.equal(Status.Cancelled);
      await expect(estafagen.connect(alice).cancelTask(1)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );

      // Completed task cannot be cancelled.
      const f2 = await loadFixture(acceptedChainFixture);
      await f2.estafagen.connect(f2.bob).completeTask(f2.subId);
      await expect(f2.estafagen.connect(f2.alice).cancelTask(f2.subId)).to.be.revertedWithCustomError(
        f2.estafagen,
        "InvalidStatus"
      );
    });

    it("creator can cancel a Delegated task; non-creator cancel reverts NotCreator", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await expect(estafagen.connect(bob).cancelTask(2)).to.be.revertedWithCustomError(
        estafagen,
        "NotCreator"
      );
      await expect(estafagen.connect(alice).cancelTask(2))
        .to.emit(estafagen, "TaskCancelled")
        .withArgs(2, alice.address);
    });
  });

  describe("tasks: wrong-caller and invalid-status reverts", function () {
    it("accept/complete/reject by a non-assignee revert NotAssignee", async function () {
      const { estafagen, alice, bob, carol } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await expect(estafagen.connect(carol).acceptDelegation(2)).to.be.revertedWithCustomError(
        estafagen,
        "NotAssignee"
      );
      await expect(estafagen.connect(carol).rejectDelegation(2)).to.be.revertedWithCustomError(
        estafagen,
        "NotAssignee"
      );
      await expect(estafagen.connect(carol).completeTask(2)).to.be.revertedWithCustomError(
        estafagen,
        "NotAssignee"
      );
    });

    it("delegating by a holder who is neither creator nor assignee reverts NotCreator", async function () {
      const { estafagen, alice, bob, carol } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await expect(
        estafagen.connect(carol).delegateTask(1, bob.address, "S", "d")
      ).to.be.revertedWithCustomError(estafagen, "NotCreator");
    });

    it("delegating to a non-holder reverts NotAgentIdHolder", async function () {
      const { estafagen, alice, dave } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await expect(
        estafagen.connect(alice).delegateTask(1, dave.address, "S", "d")
      ).to.be.revertedWithCustomError(estafagen, "NotAgentIdHolder");
    });

    it("delegating from a Completed parent reverts NotDelegatable", async function () {
      // Parent here is subtask 2 (completed by bob). Note: a root task can never
      // become Completed under the plan's state machine (it starts Open and only
      // subtasks pass through Delegated -> Accepted -> Completed), so the
      // Completed-parent case is exercised on a subtask.
      const { estafagen, alice, bob, carol } = await loadFixture(acceptedChainFixture);
      await estafagen.connect(bob).completeTask(2);
      await expect(
        estafagen.connect(alice).delegateTask(2, carol.address, "S2", "d")
      ).to.be.revertedWithCustomError(estafagen, "NotDelegatable");
    });

    it("delegating from a Cancelled parent reverts NotDelegatable", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).cancelTask(1);
      await expect(
        estafagen.connect(alice).delegateTask(1, bob.address, "S", "d")
      ).to.be.revertedWithCustomError(estafagen, "NotDelegatable");
    });

    it("delegating from a Delegated (not yet accepted) parent reverts NotDelegatable", async function () {
      const { estafagen, alice, bob, carol } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await estafagen.connect(alice).delegateTask(1, bob.address, "S", "d");
      await expect(
        estafagen.connect(bob).delegateTask(2, carol.address, "S2", "d")
      ).to.be.revertedWithCustomError(estafagen, "NotDelegatable");
    });

    it("delegating from a nonexistent parent reverts NotDelegatable", async function () {
      const { estafagen, alice, bob } = await loadFixture(deployFixture);
      await expect(
        estafagen.connect(alice).delegateTask(99, bob.address, "S", "d")
      ).to.be.revertedWithCustomError(estafagen, "NotDelegatable");
      await expect(
        estafagen.connect(alice).delegateTask(0, bob.address, "S", "d")
      ).to.be.revertedWithCustomError(estafagen, "NotDelegatable");
    });

    it("accept/complete on an Open task revert InvalidStatus", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await expect(estafagen.connect(alice).acceptDelegation(1)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );
      await expect(estafagen.connect(alice).completeTask(1)).to.be.revertedWithCustomError(
        estafagen,
        "InvalidStatus"
      );
    });
  });

  describe("pause", function () {
    it("non-owner cannot pause", async function () {
      const { estafagen, alice } = await loadFixture(deployFixture);
      await expect(estafagen.connect(alice).pause())
        .to.be.revertedWithCustomError(estafagen, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("owner pauses and unpauses; state changes revert while paused", async function () {
      const { estafagen, owner, alice, bob } = await loadFixture(deployFixture);
      await estafagen.connect(alice).createTask("T", "d");
      await expect(estafagen.connect(owner).pause())
        .to.emit(estafagen, "Paused")
        .withArgs(owner.address);
      expect(await estafagen.paused()).to.equal(true);

      await expect(estafagen.connect(alice).publishProfile("a.ai", "x", "y"))
        .to.be.revertedWithCustomError(estafagen, "EnforcedPause");
      await expect(estafagen.connect(alice).createTask("T2", "d"))
        .to.be.revertedWithCustomError(estafagen, "EnforcedPause");
      await expect(estafagen.connect(alice).delegateTask(1, bob.address, "S", "d"))
        .to.be.revertedWithCustomError(estafagen, "EnforcedPause");
      await expect(estafagen.connect(alice).removeProfile())
        .to.be.revertedWithCustomError(estafagen, "EnforcedPause");

      // Reads keep working while paused.
      expect((await estafagen.getTask(1)).status).to.equal(Status.Open);

      await expect(estafagen.connect(owner).unpause())
        .to.emit(estafagen, "Unpaused")
        .withArgs(owner.address);
      expect(await estafagen.paused()).to.equal(false);
      await expect(estafagen.connect(alice).createTask("T2", "d"))
        .to.emit(estafagen, "TaskCreated")
        .withArgs(2, alice.address);
    });

    it("pause twice reverts EnforcedPause; unpause when not paused reverts ExpectedPause", async function () {
      const { estafagen, owner } = await loadFixture(deployFixture);
      await expect(estafagen.connect(owner).unpause()).to.be.revertedWithCustomError(
        estafagen,
        "ExpectedPause"
      );
      await estafagen.connect(owner).pause();
      await expect(estafagen.connect(owner).pause()).to.be.revertedWithCustomError(
        estafagen,
        "EnforcedPause"
      );
    });
  });
});

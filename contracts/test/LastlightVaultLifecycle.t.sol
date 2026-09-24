// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LastlightVault} from "../src/LastlightVault.sol";

interface Vm {
    function warp(uint256 timestamp) external;
    function prank(address sender) external;
    function expectRevert(bytes calldata data) external;
    function deal(address account, uint256 newBalance) external;
}

contract RejectingReceiver {
    receive() external payable { revert("no BOT"); }
}

contract ReentrantReceiver {
    LastlightVault private vault;
    uint256 private vaultId;
    bool private attempted;

    function arm(LastlightVault target, uint256 id) external {
        vault = target;
        vaultId = id;
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            (bool ok,) = address(vault).call(abi.encodeWithSelector(LastlightVault.claim.selector, vaultId, payable(address(this))));
            require(!ok, "reentry succeeded");
        }
    }
}

contract ForceSender {
    constructor() payable {}
    function force(address payable target) external { selfdestruct(target); }
}

contract LastlightVaultLifecycleTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant SUCCESSOR = address(0xBEEF);
    address private constant NEW_SUCCESSOR = address(0xCAFE);
    address private constant THIRD_SUCCESSOR = address(0xF00D);
    address private constant UNRELATED = address(0xD00D);

    receive() external payable {}

    function testBoundaryStatusUsesBlockTime() external {
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 createdAt = vault.getVault(id).createdAt;
        vm.warp(createdAt + 60);
        require(uint8(vault.getVaultStatus(id)) == uint8(LastlightVault.VaultStatus.GRACE), "R is grace");
        vm.warp(createdAt + 90);
        require(uint8(vault.getVaultStatus(id)) == uint8(LastlightVault.VaultStatus.CLAIMABLE), "D is claimable");
    }

    function testBoundaryStatusAndWritesAtRMinusOneRAndDMinusOneD() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 createdAt = vault.getVault(id).createdAt;

        vm.warp(createdAt + 59);
        require(uint8(vault.getVaultStatus(id)) == uint8(LastlightVault.VaultStatus.ACTIVE), "R-1 active");
        vault.heartbeat(id);
        uint256 heartbeatAt = vault.getVault(id).lastHeartbeat;

        vm.warp(heartbeatAt + 60);
        require(uint8(vault.getVaultStatus(id)) == uint8(LastlightVault.VaultStatus.GRACE), "R grace");
        vault.heartbeat(id);
        heartbeatAt = vault.getVault(id).lastHeartbeat;

        vm.warp(heartbeatAt + 89);
        require(uint8(vault.getVaultStatus(id)) == uint8(LastlightVault.VaultStatus.GRACE), "D-1 grace");
        vault.changeSuccessor(id, NEW_SUCCESSOR);
        vm.warp(heartbeatAt + 90);
        require(uint8(vault.getVaultStatus(id)) == uint8(LastlightVault.VaultStatus.CLAIMABLE), "D claimable");
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.OwnerWindowClosed.selector, id, heartbeatAt + 90));
        vault.cancelVault(id, payable(address(this)));
        vm.warp(heartbeatAt + 91);
        require(uint8(vault.getVaultStatus(id)) == uint8(LastlightVault.VaultStatus.CLAIMABLE), "D+1 remains claimable");
    }

    function testWrongOwnerCannotHeartbeatAndOldSuccessorLosesList() external {
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.NotVaultOwner.selector, UNRELATED, address(this)));
        vm.prank(UNRELATED);
        vault.heartbeat(id);

        LastlightVault.Vault memory beforeChange = vault.getVault(id);
        vault.changeSuccessor(id, NEW_SUCCESSOR);
        LastlightVault.Vault memory afterChange = vault.getVault(id);
        require(afterChange.successor == NEW_SUCCESSOR, "new successor");
        require(afterChange.lastHeartbeat == beforeChange.lastHeartbeat, "heartbeat unchanged");
        require(afterChange.inactivityPeriod == beforeChange.inactivityPeriod && afterChange.gracePeriod == beforeChange.gracePeriod, "policy unchanged");
        (uint256[] memory oldIds, uint256 oldTotal) = vault.getVaultIdsBySuccessor(SUCCESSOR, 0, 1);
        (uint256[] memory newIds, uint256 newTotal) = vault.getVaultIdsBySuccessor(NEW_SUCCESSOR, 0, 1);
        require(oldIds.length == 0 && oldTotal == 0, "old list");
        require(newIds.length == 1 && newIds[0] == id && newTotal == 1, "new list");
    }

    function testWrongRoleCannotUseAnyWriteAndEarlyClaimIsRejected() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);

        vm.expectRevert(abi.encodeWithSelector(LastlightVault.NotVaultOwner.selector, UNRELATED, address(this)));
        vm.prank(UNRELATED);
        vault.changeSuccessor(id, NEW_SUCCESSOR);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.NotVaultOwner.selector, UNRELATED, address(this)));
        vm.prank(UNRELATED);
        vault.cancelVault(id, payable(UNRELATED));
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.NotVaultSuccessor.selector, UNRELATED, SUCCESSOR));
        vm.prank(UNRELATED);
        vault.claim(id, payable(UNRELATED));
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.VaultNotClaimable.selector, id, vault.getVaultView(id).claimableAt));
        vm.prank(SUCCESSOR);
        vault.claim(id, payable(UNRELATED));
    }

    function testClaimIsFullAndOneTime() external {
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 deadline = vault.getVaultView(id).claimableAt;
        vm.warp(deadline);
        vm.prank(SUCCESSOR);
        vault.claim(id, payable(address(this)));
        LastlightVault.Vault memory settled = vault.getVault(id);
        require(settled.amount == 0 && settled.settlement == LastlightVault.Settlement.CLAIMED, "settled");
        require(vault.totalLocked() == 0 && vault.totalClaimed() == 1 ether, "accounting");
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.VaultAlreadyClaimed.selector, id));
        vm.prank(SUCCESSOR);
        vault.claim(id, payable(address(this)));
    }

    function testOwnerCannotWriteAtFinalDeadline() external {
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 deadline = vault.getVaultView(id).claimableAt;
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.OwnerWindowClosed.selector, id, deadline));
        vault.heartbeat(id);
    }

    function testOwnerCannotChangeOrCancelAtFinalDeadlineAndTerminalWritesStayBlocked() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 deadline = vault.getVaultView(id).claimableAt;
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.OwnerWindowClosed.selector, id, deadline));
        vault.changeSuccessor(id, NEW_SUCCESSOR);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.OwnerWindowClosed.selector, id, deadline));
        vault.cancelVault(id, payable(address(this)));

        vm.prank(SUCCESSOR);
        vault.claim(id, payable(address(this)));
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.VaultAlreadyClaimed.selector, id));
        vault.heartbeat(id);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.VaultAlreadyClaimed.selector, id));
        vault.changeSuccessor(id, NEW_SUCCESSOR);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.VaultAlreadyClaimed.selector, id));
        vault.cancelVault(id, payable(address(this)));
    }

    function testRevertingPayoutRollsBackSettlement() external {
        LastlightVault vault = new LastlightVault();
        RejectingReceiver receiver = new RejectingReceiver();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.NativeTransferFailed.selector, address(receiver), 1 ether));
        vault.cancelVault(id, payable(address(receiver)));
        LastlightVault.Vault memory item = vault.getVault(id);
        require(item.amount == 1 ether && item.settlement == LastlightVault.Settlement.NONE, "rollback");
        require(vault.totalLocked() == 1 ether && vault.totalReturned() == 0, "accounting rollback");
    }

    function testRevertingClaimRollsBackSettlement() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        RejectingReceiver receiver = new RejectingReceiver();
        uint256 id = vault.createVault{value: 1 ether}(address(receiver), 60, 30);
        uint256 deadline = vault.getVaultView(id).claimableAt;
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.NativeTransferFailed.selector, address(receiver), 1 ether));
        vm.prank(address(receiver));
        vault.claim(id, payable(address(receiver)));
        LastlightVault.Vault memory item = vault.getVault(id);
        require(item.amount == 1 ether && item.settlement == LastlightVault.Settlement.NONE, "claim rollback");
        require(vault.totalLocked() == 1 ether && vault.totalClaimed() == 0, "claim accounting rollback");
    }

    function testDirectPaymentIsDisabled() external {
        vm.deal(address(this), 1 ether);
        LastlightVault vault = new LastlightVault();
        (bool ok,) = address(vault).call{value: 1} ("");
        require(!ok, "direct payment accepted");
    }

    function testInvalidAddressesAndZeroFundingRevert() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.InvalidAmount.selector));
        vault.createVault{value: 0}(SUCCESSOR, 60, 30);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.InvalidSuccessor.selector, address(0)));
        vault.createVault{value: 1}(address(0), 60, 30);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.SuccessorIsOwner.selector));
        vault.createVault{value: 1}(address(this), 60, 30);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.InvalidSuccessor.selector, address(vault)));
        vault.createVault{value: 1}(address(vault), 60, 30);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.VaultNotFound.selector, 0));
        vault.getVault(0);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.VaultNotFound.selector, 99));
        vault.getVault(99);
    }

    function testInvalidBoundsAndPageLimitsRevert() external {
        LastlightVault vault = new LastlightVault();
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.InvalidInactivityPeriod.selector, 59));
        vault.createVault{value: 1}(SUCCESSOR, 59, 30);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.InvalidGracePeriod.selector, 29));
        vault.createVault{value: 1}(SUCCESSOR, 60, 29);
        vault.createVault{value: 1}(SUCCESSOR, 60, 30);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.InvalidPageSize.selector, 0));
        vault.getVaultIdsByOwner(address(this), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.InvalidPageSize.selector, 51));
        vault.getVaultIdsByOwner(address(this), 0, 51);
    }

    function testMinimumMaximumPeriodsAndPaginationPages() external {
        vm.deal(address(this), 10 ether);
        LastlightVault vault = new LastlightVault();
        uint256 first = vault.createVault{value: 1 ether}(SUCCESSOR, vault.MIN_INACTIVITY_PERIOD(), vault.MIN_GRACE_PERIOD());
        uint256 second = vault.createVault{value: 1 ether}(NEW_SUCCESSOR, vault.MAX_INACTIVITY_PERIOD(), vault.MAX_GRACE_PERIOD());
        (uint256[] memory firstPage, uint256 total) = vault.getVaultIdsByOwner(address(this), 0, 1);
        require(total == 2 && firstPage.length == 1 && firstPage[0] == first, "first page");
        (uint256[] memory secondPage, uint256 secondTotal) = vault.getVaultIdsByOwner(address(this), 1, 50);
        require(secondTotal == 2 && secondPage.length == 1 && secondPage[0] == second, "second page");
        (uint256[] memory emptyPage, uint256 emptyTotal) = vault.getVaultIdsByOwner(address(this), 50, 50);
        require(emptyTotal == 2 && emptyPage.length == 0, "empty page");
    }

    function testPaginationHandlesMoreThanOneMaximumPage() external {
        vm.deal(address(this), 1 ether);
        LastlightVault vault = new LastlightVault();
        for (uint256 index = 0; index < 51; index++) {
            vault.createVault{value: 1 wei}(address(uint160(0x1000 + index)), 60, 30);
        }

        (uint256[] memory firstPage, uint256 firstTotal) = vault.getVaultIdsByOwner(address(this), 0, 50);
        require(firstTotal == 51 && firstPage.length == 50 && firstPage[0] == 1 && firstPage[49] == 50, "full first page");
        (uint256[] memory finalPage, uint256 finalTotal) = vault.getVaultIdsByOwner(address(this), 50, 50);
        require(finalTotal == 51 && finalPage.length == 1 && finalPage[0] == 51, "final page");
        (uint256[] memory emptyPage, uint256 emptyTotal) = vault.getVaultIdsByOwner(address(this), 51, 50);
        require(emptyTotal == 51 && emptyPage.length == 0, "past-total page");
    }

    function testCloseDuringGraceIsFullAndPayoutDoesNotChangeAuthority() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 createdAt = vault.getVault(id).createdAt;
        vm.warp(createdAt + 60);
        uint256 before = address(this).balance;
        vault.cancelVault(id, payable(address(this)));
        LastlightVault.Vault memory item = vault.getVault(id);
        require(item.amount == 0 && item.settlement == LastlightVault.Settlement.CANCELLED, "cancel state");
        require(item.settlementRecipient == address(this), "payout metadata");
        require(address(this).balance == before + 1 ether, "full payout");
        require(vault.totalLocked() == 0 && vault.totalReturned() == 1 ether, "cancel totals");
    }

    function testCloseDuringActiveIsTerminalAndCannotBeClaimed() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        vault.cancelVault(id, payable(address(this)));
        LastlightVault.Vault memory item = vault.getVault(id);
        require(item.amount == 0 && item.settlement == LastlightVault.Settlement.CANCELLED, "active close");
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.VaultAlreadyCancelled.selector, id));
        vm.prank(SUCCESSOR);
        vault.claim(id, payable(address(this)));
    }

    function testFormerSuccessorCannotClaimAfterReplacement() external {
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        vault.changeSuccessor(id, NEW_SUCCESSOR);
        uint256 deadline = vault.getVaultView(id).claimableAt;
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(LastlightVault.NotVaultSuccessor.selector, SUCCESSOR, NEW_SUCCESSOR));
        vm.prank(SUCCESSOR);
        vault.claim(id, payable(address(this)));
        vm.prank(NEW_SUCCESSOR);
        vault.claim(id, payable(address(this)));
        require(vault.totalClaimed() == 1 ether, "current successor claim");
    }

    function testReentrantClaimIsRejectedAndPayoutRemainsAtomic() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        ReentrantReceiver receiver = new ReentrantReceiver();
        uint256 id = vault.createVault{value: 1 ether}(address(receiver), 60, 30);
        receiver.arm(vault, id);
        vm.warp(vault.getVaultView(id).claimableAt);
        vm.prank(address(receiver));
        vault.claim(id, payable(address(receiver)));
        require(vault.totalLocked() == 0 && vault.totalClaimed() == 1 ether, "reentrant accounting");
    }

    function testForcedSurplusIsNotLiability() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        ForceSender force = new ForceSender{value: 2 ether}();
        force.force(payable(address(vault)));
        require(address(vault).balance == 3 ether && vault.totalLocked() == 1 ether, "surplus");
        vault.cancelVault(id, payable(address(this)));
        require(address(vault).balance == 2 ether && vault.totalReturned() == 1 ether, "surplus remains");
    }

    function testSameTimestampHeartbeatDoesNotPromiseAnExtension() external {
        vm.deal(address(this), 5 ether);
        LastlightVault vault = new LastlightVault();
        uint256 id = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        vm.warp(vault.getVault(id).lastHeartbeat + 10);
        vault.heartbeat(id);
        uint256 firstHeartbeat = vault.getVault(id).lastHeartbeat;
        vault.heartbeat(id);
        LastlightVault.Vault memory item = vault.getVault(id);
        require(item.lastHeartbeat == firstHeartbeat, "same timestamp changed H");
        require(item.amount == 1 ether && vault.totalLocked() == 1 ether, "same timestamp accounting");
    }

    function testSuccessorIndexRemovesHeadMiddleAndTail() external {
        vm.deal(address(this), 10 ether);
        LastlightVault vault = new LastlightVault();
        uint256 first = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 middle = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 tail = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);

        vault.changeSuccessor(middle, NEW_SUCCESSOR);
        (uint256[] memory afterMiddle, uint256 totalAfterMiddle) = vault.getVaultIdsBySuccessor(SUCCESSOR, 0, 50);
        require(totalAfterMiddle == 2 && afterMiddle.length == 2, "middle removal length");
        require((afterMiddle[0] == first && afterMiddle[1] == tail) || (afterMiddle[0] == tail && afterMiddle[1] == first), "middle removal ids");

        vault.changeSuccessor(first, THIRD_SUCCESSOR);
        (uint256[] memory afterHead, uint256 totalAfterHead) = vault.getVaultIdsBySuccessor(SUCCESSOR, 0, 50);
        require(totalAfterHead == 1 && afterHead.length == 1 && afterHead[0] == tail, "head removal");

        vault.changeSuccessor(tail, THIRD_SUCCESSOR);
        (uint256[] memory afterTail, uint256 totalAfterTail) = vault.getVaultIdsBySuccessor(SUCCESSOR, 0, 50);
        require(totalAfterTail == 0 && afterTail.length == 0, "tail removal");
    }

    function testCrossVaultIsolationAndSettlementBlockMetadata() external {
        vm.deal(address(this), 10 ether);
        LastlightVault vault = new LastlightVault();
        uint256 first = vault.createVault{value: 1 ether}(SUCCESSOR, 60, 30);
        uint256 second = vault.createVault{value: 2 ether}(NEW_SUCCESSOR, 60, 30);
        uint256 firstHeartbeatBefore = vault.getVault(first).lastHeartbeat;
        uint256 secondHeartbeatBefore = vault.getVault(second).lastHeartbeat;
        vm.warp(secondHeartbeatBefore + 10);
        vault.heartbeat(first);
        LastlightVault.Vault memory firstAfter = vault.getVault(first);
        LastlightVault.Vault memory secondAfter = vault.getVault(second);
        require(firstAfter.lastHeartbeat > firstHeartbeatBefore && secondAfter.lastHeartbeat == secondHeartbeatBefore, "cross vault heartbeat");
        require(firstAfter.createdBlock > 0 && firstAfter.lastHeartbeatBlock > 0 && firstAfter.lastHeartbeatBlock >= firstAfter.createdBlock, "block metadata");
        vault.cancelVault(first, payable(address(this)));
        LastlightVault.Vault memory settled = vault.getVault(first);
        require(settled.settledBlock > 0 && settled.settledAt > 0 && settled.settlementRecipient == address(this), "settlement metadata");
        require(vault.totalFunded() == 3 ether && vault.totalReturned() == 1 ether && vault.totalLocked() == 2 ether, "cross vault totals");
    }

    function testFuzzValidPolicyAndAmount(uint256 amountSeed, uint256 inactivitySeed, uint256 graceSeed) external {
        uint256 amount = (amountSeed % 1 ether) + 1;
        vm.deal(address(this), amount + 1 ether);
        LastlightVault vault = new LastlightVault();
        uint256 inactivity = vault.MIN_INACTIVITY_PERIOD() + (inactivitySeed % (vault.MAX_INACTIVITY_PERIOD() - vault.MIN_INACTIVITY_PERIOD() + 1));
        uint256 grace = vault.MIN_GRACE_PERIOD() + (graceSeed % (vault.MAX_GRACE_PERIOD() - vault.MIN_GRACE_PERIOD() + 1));
        uint256 id = vault.createVault{value: amount}(SUCCESSOR, inactivity, grace);
        LastlightVault.Vault memory item = vault.getVault(id);
        require(item.amount == amount && item.depositedAmount == amount, "fuzz amount");
        require(item.inactivityPeriod == inactivity && item.gracePeriod == grace, "fuzz policy");
        require(vault.totalLocked() == amount && vault.totalFunded() == amount, "fuzz totals");
    }
}

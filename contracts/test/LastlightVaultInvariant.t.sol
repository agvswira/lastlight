// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LastlightVault} from "../src/LastlightVault.sol";

interface VmInvariant {
    function deal(address account, uint256 newBalance) external;
    function warp(uint256 timestamp) external;
    function prank(address sender) external;
}

contract LastlightVaultInvariantHandler {
    VmInvariant private constant vm = VmInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));
    LastlightVault public immutable vault;
    address public constant SUCCESSOR = address(0xBEEF);
    address public constant ALTERNATE_SUCCESSOR = address(0xCAFE);

    constructor(LastlightVault target) {
        vault = target;
        vm.deal(address(this), type(uint128).max);
    }

    receive() external payable {}

    function create(uint256 amountSeed, uint256 inactivitySeed, uint256 graceSeed) external {
        uint256 amount = 1e12 + amountSeed % 1 ether;
        uint256 inactivity = 60 + inactivitySeed % (365 days - 60 + 1);
        uint256 grace = 30 + graceSeed % (30 days - 30 + 1);
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = address(vault).call{value: amount}(
            abi.encodeWithSelector(LastlightVault.createVault.selector, SUCCESSOR, inactivity, grace)
        );
        ok;
    }

    function heartbeat(uint256 idSeed) external {
        uint256 id = 1 + idSeed % 100;
        (bool ok,) = address(vault).call(abi.encodeWithSelector(LastlightVault.heartbeat.selector, id));
        ok;
    }

    function changeSuccessor(uint256 idSeed, bool alternate) external {
        uint256 id = 1 + idSeed % 100;
        address next = alternate ? ALTERNATE_SUCCESSOR : SUCCESSOR;
        (bool ok,) = address(vault).call(abi.encodeWithSelector(LastlightVault.changeSuccessor.selector, id, next));
        ok;
    }

    function cancel(uint256 idSeed) external {
        uint256 id = 1 + idSeed % 100;
        (bool ok,) = address(vault).call(abi.encodeWithSelector(LastlightVault.cancelVault.selector, id, payable(address(this))));
        ok;
    }

    function claim(uint256 idSeed, bool alternate) external {
        uint256 id = 1 + idSeed % 100;
        address caller = alternate ? ALTERNATE_SUCCESSOR : SUCCESSOR;
        vm.prank(caller);
        (bool ok,) = address(vault).call(abi.encodeWithSelector(LastlightVault.claim.selector, id, payable(caller)));
        ok;
    }

    function advance(uint256 secondsSeed) external {
        vm.warp(block.timestamp + secondsSeed % (3 days + 1));
    }
}

contract LastlightVaultInvariantTest {
    VmInvariant private constant vm = VmInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));
    LastlightVault private vault;
    LastlightVaultInvariantHandler private handler;

    function setUp() external {
        vault = new LastlightVault();
        handler = new LastlightVaultInvariantHandler(vault);
    }

    function invariantAccountingIdentityAndBalanceCoverLiability() external view {
        require(vault.totalFunded() == vault.totalLocked() + vault.totalClaimed() + vault.totalReturned(), "accounting identity");
        require(address(vault).balance >= vault.totalLocked(), "liability is solvent");
    }

    function invariantHandlerIsConfigured() external view {
        require(address(handler.vault()) == address(vault), "handler target");
    }
}

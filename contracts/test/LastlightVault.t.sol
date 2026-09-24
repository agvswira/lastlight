// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LastlightVault} from "../src/LastlightVault.sol";

contract LastlightVaultTest {
    function testCreateStoresTheWholePolicy() external {
        LastlightVault vault = new LastlightVault();
        address successor = address(0xBEEF);
        uint256 id = vault.createVault{value: 1 ether}(successor, 90 days, 30 days);
        LastlightVault.Vault memory item = vault.getVault(id);
        require(id == 1, "first id");
        require(item.owner == address(this), "owner");
        require(item.successor == successor, "successor");
        require(item.amount == 1 ether, "amount");
        require(item.inactivityPeriod == 90 days, "interval");
        require(item.gracePeriod == 30 days, "grace");
        require(uint8(vault.getVaultStatus(id)) == 0, "active");
        require(vault.totalFunded() == 1 ether && vault.totalLocked() == 1 ether, "totals");
    }

    function testPaginationReturnsEmptyForOffsetPastTotal() external {
        LastlightVault vault = new LastlightVault();
        vault.createVault{value: 1}(address(0xBEEF), 60, 30);
        (uint256[] memory ids, uint256 total) = vault.getVaultIdsByOwner(address(this), type(uint256).max, 1);
        require(ids.length == 0 && total == 1, "page");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LastlightVault} from "../src/LastlightVault.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployLastlightVault {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (LastlightVault deployed) {
        vm.startBroadcast();
        deployed = new LastlightVault();
        vm.stopBroadcast();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LastlightVault
/// @notice Native BOT continuity plans with an owner recovery window and a single recipient claim.
/// @dev Time is read from block.timestamp. No keeper, admin, fee, pause, or upgrade path exists.
contract LastlightVault is ReentrancyGuard {
    string public constant PROTOCOL_VERSION = "3.0.0";
    uint256 public constant MIN_INACTIVITY_PERIOD = 60;
    uint256 public constant MAX_INACTIVITY_PERIOD = 365 days;
    uint256 public constant MIN_GRACE_PERIOD = 30;
    uint256 public constant MAX_GRACE_PERIOD = 30 days;
    uint256 public constant MAX_PAGE_SIZE = 50;

    enum Settlement { NONE, CANCELLED, CLAIMED }
    enum VaultStatus { ACTIVE, GRACE, CLAIMABLE, CANCELLED, CLAIMED }

    struct Vault {
        address owner;
        address successor;
        address previousSuccessor;
        address settlementRecipient;
        uint256 depositedAmount;
        uint256 amount;
        uint256 createdAt;
        uint256 lastHeartbeat;
        uint256 inactivityPeriod;
        uint256 gracePeriod;
        uint256 settledAt;
        uint256 createdBlock;
        uint256 lastHeartbeatBlock;
        uint256 successorChangedBlock;
        uint256 settledBlock;
        Settlement settlement;
    }

    struct VaultView {
        Vault vault;
        VaultStatus status;
        uint256 checkInBy;
        uint256 claimableAt;
        uint256 observedAt;
        uint256 observedBlock;
    }

    error InvalidAmount();
    error InvalidSuccessor(address successor);
    error SuccessorIsOwner();
    error SameSuccessor();
    error InvalidInactivityPeriod(uint256 supplied);
    error InvalidGracePeriod(uint256 supplied);
    error InvalidRecipient(address recipient);
    error VaultNotFound(uint256 vaultId);
    error NotVaultOwner(address caller, address owner);
    error NotVaultSuccessor(address caller, address successor);
    error VaultAlreadyCancelled(uint256 vaultId);
    error VaultAlreadyClaimed(uint256 vaultId);
    error OwnerWindowClosed(uint256 vaultId, uint256 claimableAt);
    error VaultNotClaimable(uint256 vaultId, uint256 claimableAt);
    error EmptyVault(uint256 vaultId);
    error InvalidPageSize(uint256 supplied);
    error NativeTransferFailed(address recipient, uint256 amount);
    error DirectPaymentDisabled();

    event VaultCreated(
        uint256 indexed vaultId,
        address indexed owner,
        address indexed successor,
        uint256 amount,
        uint256 inactivityPeriod,
        uint256 gracePeriod,
        uint256 createdAt
    );
    event Heartbeat(uint256 indexed vaultId, address indexed owner, uint256 previousHeartbeat, uint256 newHeartbeat);
    event SuccessorChanged(uint256 indexed vaultId, address indexed previousSuccessor, address indexed newSuccessor);
    event VaultCancelled(uint256 indexed vaultId, address indexed owner, address indexed recipient, uint256 amount);
    event VaultClaimed(uint256 indexed vaultId, address indexed successor, address indexed recipient, uint256 amount);

    uint256 public nextVaultId = 1;
    uint256 public totalFunded;
    uint256 public totalLocked;
    uint256 public totalClaimed;
    uint256 public totalReturned;

    mapping(uint256 => Vault) private _vaults;
    mapping(address => uint256[]) private _ownerVaultIds;
    mapping(address => uint256[]) private _successorVaultIds;
    mapping(address => mapping(uint256 => uint256)) private _successorIndexPlusOne;

    function createVault(address successor, uint256 inactivityPeriod, uint256 gracePeriod)
        external
        payable
        nonReentrant
        returns (uint256 vaultId)
    {
        if (msg.value == 0) revert InvalidAmount();
        _validateSuccessor(msg.sender, successor);
        _validatePeriods(inactivityPeriod, gracePeriod);

        vaultId = nextVaultId++;
        Vault storage vault = _vaults[vaultId];
        uint256 nowTimestamp = block.timestamp;
        vault.owner = msg.sender;
        vault.successor = successor;
        vault.depositedAmount = msg.value;
        vault.amount = msg.value;
        vault.createdAt = nowTimestamp;
        vault.lastHeartbeat = nowTimestamp;
        vault.inactivityPeriod = inactivityPeriod;
        vault.gracePeriod = gracePeriod;
        vault.createdBlock = block.number;
        vault.lastHeartbeatBlock = block.number;

        _ownerVaultIds[msg.sender].push(vaultId);
        _addSuccessorVault(successor, vaultId);
        totalFunded += msg.value;
        totalLocked += msg.value;

        emit VaultCreated(vaultId, msg.sender, successor, msg.value, inactivityPeriod, gracePeriod, nowTimestamp);
    }

    function heartbeat(uint256 vaultId) external nonReentrant {
        Vault storage vault = _existing(vaultId);
        _requireOwner(vault);
        _requireUnsettled(vaultId, vault);
        uint256 claimableAt = _claimableAt(vault);
        if (block.timestamp >= claimableAt) revert OwnerWindowClosed(vaultId, claimableAt);
        uint256 previousHeartbeat = vault.lastHeartbeat;
        vault.lastHeartbeat = block.timestamp;
        vault.lastHeartbeatBlock = block.number;
        emit Heartbeat(vaultId, msg.sender, previousHeartbeat, block.timestamp);
    }

    function changeSuccessor(uint256 vaultId, address newSuccessor) external nonReentrant {
        Vault storage vault = _existing(vaultId);
        _requireOwner(vault);
        _requireUnsettled(vaultId, vault);
        uint256 claimableAt = _claimableAt(vault);
        if (block.timestamp >= claimableAt) revert OwnerWindowClosed(vaultId, claimableAt);
        _validateSuccessor(msg.sender, newSuccessor);
        if (newSuccessor == vault.successor) revert SameSuccessor();

        address previousSuccessor = vault.successor;
        _removeSuccessorVault(previousSuccessor, vaultId);
        _addSuccessorVault(newSuccessor, vaultId);
        vault.previousSuccessor = previousSuccessor;
        vault.successor = newSuccessor;
        vault.successorChangedBlock = block.number;
        emit SuccessorChanged(vaultId, previousSuccessor, newSuccessor);
    }

    function cancelVault(uint256 vaultId, address payable recipient) external nonReentrant {
        Vault storage vault = _existing(vaultId);
        _requireOwner(vault);
        _requireUnsettled(vaultId, vault);
        uint256 claimableAt = _claimableAt(vault);
        if (block.timestamp >= claimableAt) revert OwnerWindowClosed(vaultId, claimableAt);
        _validateRecipient(recipient);
        uint256 payout = vault.amount;
        if (payout == 0) revert EmptyVault(vaultId);

        vault.amount = 0;
        vault.settlement = Settlement.CANCELLED;
        vault.settlementRecipient = recipient;
        vault.settledAt = block.timestamp;
        vault.settledBlock = block.number;
        totalLocked -= payout;
        totalReturned += payout;
        emit VaultCancelled(vaultId, msg.sender, recipient, payout);
        _pay(recipient, payout);
    }

    function claim(uint256 vaultId, address payable recipient) external nonReentrant {
        Vault storage vault = _existing(vaultId);
        _requireSuccessor(vault);
        _requireUnsettled(vaultId, vault);
        uint256 claimableAt = _claimableAt(vault);
        if (block.timestamp < claimableAt) revert VaultNotClaimable(vaultId, claimableAt);
        _validateRecipient(recipient);
        uint256 payout = vault.amount;
        if (payout == 0) revert EmptyVault(vaultId);

        vault.amount = 0;
        vault.settlement = Settlement.CLAIMED;
        vault.settlementRecipient = recipient;
        vault.settledAt = block.timestamp;
        vault.settledBlock = block.number;
        totalLocked -= payout;
        totalClaimed += payout;
        emit VaultClaimed(vaultId, msg.sender, recipient, payout);
        _pay(recipient, payout);
    }

    function getVault(uint256 vaultId) external view returns (Vault memory) {
        return _existing(vaultId);
    }

    function getVaultView(uint256 vaultId) external view returns (VaultView memory view_) {
        Vault memory vault = _existing(vaultId);
        view_.vault = vault;
        view_.checkInBy = vault.lastHeartbeat + vault.inactivityPeriod;
        view_.claimableAt = view_.checkInBy + vault.gracePeriod;
        view_.status = _status(vault, block.timestamp);
        view_.observedAt = block.timestamp;
        view_.observedBlock = block.number;
    }

    function getVaultStatus(uint256 vaultId) external view returns (VaultStatus) {
        Vault memory vault = _existing(vaultId);
        return _status(vault, block.timestamp);
    }

    function getVaultIdsByOwner(address account, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_ownerVaultIds[account], offset, limit);
    }

    function getVaultIdsBySuccessor(address account, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_successorVaultIds[account], offset, limit);
    }

    receive() external payable { revert DirectPaymentDisabled(); }
    fallback() external payable { revert DirectPaymentDisabled(); }

    function _existing(uint256 vaultId) private view returns (Vault storage vault) {
        if (vaultId == 0 || _vaults[vaultId].owner == address(0)) revert VaultNotFound(vaultId);
        return _vaults[vaultId];
    }

    function _requireOwner(Vault storage vault) private view {
        if (msg.sender != vault.owner) revert NotVaultOwner(msg.sender, vault.owner);
    }

    function _requireSuccessor(Vault storage vault) private view {
        if (msg.sender != vault.successor) revert NotVaultSuccessor(msg.sender, vault.successor);
    }

    function _requireUnsettled(uint256 vaultId, Vault storage vault) private view {
        if (vault.settlement == Settlement.CANCELLED) revert VaultAlreadyCancelled(vaultId);
        if (vault.settlement == Settlement.CLAIMED) revert VaultAlreadyClaimed(vaultId);
    }

    function _validateSuccessor(address owner, address successor) private view {
        if (successor == address(0) || successor == address(this)) revert InvalidSuccessor(successor);
        if (successor == owner) revert SuccessorIsOwner();
    }

    function _validatePeriods(uint256 inactivityPeriod, uint256 gracePeriod) private pure {
        if (inactivityPeriod < MIN_INACTIVITY_PERIOD || inactivityPeriod > MAX_INACTIVITY_PERIOD) revert InvalidInactivityPeriod(inactivityPeriod);
        if (gracePeriod < MIN_GRACE_PERIOD || gracePeriod > MAX_GRACE_PERIOD) revert InvalidGracePeriod(gracePeriod);
    }

    function _validateRecipient(address payable recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient(recipient);
    }

    function _claimableAt(Vault storage vault) private view returns (uint256) {
        return vault.lastHeartbeat + vault.inactivityPeriod + vault.gracePeriod;
    }

    function _status(Vault memory vault, uint256 timestamp) private pure returns (VaultStatus) {
        if (vault.settlement == Settlement.CANCELLED) return VaultStatus.CANCELLED;
        if (vault.settlement == Settlement.CLAIMED) return VaultStatus.CLAIMED;
        uint256 checkInBy = vault.lastHeartbeat + vault.inactivityPeriod;
        if (timestamp < checkInBy) return VaultStatus.ACTIVE;
        if (timestamp < checkInBy + vault.gracePeriod) return VaultStatus.GRACE;
        return VaultStatus.CLAIMABLE;
    }

    function _addSuccessorVault(address successor, uint256 vaultId) private {
        _successorVaultIds[successor].push(vaultId);
        _successorIndexPlusOne[successor][vaultId] = _successorVaultIds[successor].length;
    }

    function _removeSuccessorVault(address successor, uint256 vaultId) private {
        uint256 indexPlusOne = _successorIndexPlusOne[successor][vaultId];
        if (indexPlusOne == 0) return;
        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _successorVaultIds[successor].length - 1;
        if (index != lastIndex) {
            uint256 movedId = _successorVaultIds[successor][lastIndex];
            _successorVaultIds[successor][index] = movedId;
            _successorIndexPlusOne[successor][movedId] = index + 1;
        }
        _successorVaultIds[successor].pop();
        delete _successorIndexPlusOne[successor][vaultId];
    }

    function _page(uint256[] storage source, uint256 offset, uint256 limit)
        private
        view
        returns (uint256[] memory ids, uint256 total)
    {
        total = source.length;
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidPageSize(limit);
        if (offset >= total) return (new uint256[](0), total);
        uint256 remaining = total - offset;
        uint256 length = remaining < limit ? remaining : limit;
        ids = new uint256[](length);
        for (uint256 i = 0; i < length; i++) ids[i] = source[offset + i];
    }

    function _pay(address payable recipient, uint256 amount) private {
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert NativeTransferFailed(recipient, amount);
    }
}

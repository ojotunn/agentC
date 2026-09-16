// SPDX-License-Identifier: MIT
/*
 * (c) 2024 Coinbase
 * (c) 2026 Robinhood Markets, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
pragma solidity 0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {SignatureCheckerLib} from "solady/src/utils/SignatureCheckerLib.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

/// @notice Withdrawal contract supporting ETH and ERC20 tokens with role-based access control.
contract JustInTimeFunding is AccessControl, Pausable {
    /// @dev Role for addresses authorized to sign withdrawal requests.
    bytes32 public constant AUTHORIZER_ROLE = keccak256("AUTHORIZER_ROLE");

    /// @dev Role for addresses authorized to withdraw funds from the contract.
    bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE");

    /// @dev Role for addresses authorized to pause and unpause user withdrawals.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Signed withdraw request allowing accounts to withdraw funds from this contract.
    struct WithdrawRequest {
        /// @dev The signature associated with this withdraw request.
        bytes signature;
        /// @dev The asset to withdraw.
        address asset;
        /// @dev The requested amount to withdraw.
        uint256 amount;
        /// @dev Unique nonce used to prevent replays.
        uint256 nonce;
        /// @dev The maximum expiry the withdraw request remains valid for.
        uint48 expiry;
    }

    /// @dev Mappings keeping track of already used nonces per user to prevent replays of withdraw requests.
    mapping(uint256 nonce => mapping(address user => bool used)) internal _nonceUsed;

    /// @notice The fixed destination for `emergencyWithdraw`. Set at deploy time and never changes.
    ///
    /// @dev Binding the destination to an immutable address limits the blast radius if the
    ///      WITHDRAWER_ROLE key is compromised — funds can only ever be sent to this vault.
    address public immutable IMMUTABLE_RECOVERY_VAULT;

    /// @notice Emitted after validating a withdraw request and funds are about to be withdrawn.
    ///
    /// @param account The account address.
    /// @param asset   The asset withdrawn.
    /// @param amount  The amount withdrawn.
    /// @param nonce   The request nonce.
    event JustInTimeFundingWithdrawal(address indexed account, address indexed asset, uint256 amount, uint256 nonce);

    /// @notice Emitted when an emergency withdrawal is executed.
    ///
    /// @param asset  The asset withdrawn.
    /// @param to     The beneficiary address.
    /// @param amount The amount withdrawn.
    event EmergencyWithdrawal(address indexed asset, address indexed to, uint256 amount);

    /// @notice Thrown when the withdraw request signature is invalid.
    error InvalidSignature();

    /// @notice Thrown when trying to use a withdraw request after its expiry has been reached.
    error Expired();

    /// @notice Thrown when trying to replay a withdraw request with the same nonce.
    ///
    /// @param nonce The already used nonce.
    error InvalidNonce(uint256 nonce);

    /// @notice Deploy the contract, grant admin role, and bind the recovery vault.
    ///
    /// @param admin          The address to grant DEFAULT_ADMIN_ROLE (typically a Fireblocks vault).
    /// @param _recoveryVault The fixed destination for emergency withdrawals.
    constructor(address admin, address _recoveryVault) {
        require(admin != address(0), "Invalid admin address");
        require(_recoveryVault != address(0), "Invalid recovery address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        IMMUTABLE_RECOVERY_VAULT = _recoveryVault;
    }

    /// @notice Receive function allowing ETH to be deposited in this contract.
    receive() external payable {}

    /// @notice Allows the caller to withdraw funds by calling with a valid `withdrawRequest`.
    ///
    /// @param withdrawRequest The withdraw request.
    function withdraw(WithdrawRequest memory withdrawRequest) external whenNotPaused {
        // slither-disable-next-line timestamp
        if (block.timestamp > withdrawRequest.expiry) {
            revert Expired();
        }

        if (!isValidWithdrawSignature(msg.sender, withdrawRequest)) {
            revert InvalidSignature();
        }

        _validateRequest(msg.sender, withdrawRequest);

        _withdraw(withdrawRequest.asset, msg.sender, withdrawRequest.amount);
    }

    /// @notice Emergency withdrawal of funds from this contract to the immutable recovery vault.
    ///
    /// @dev Reverts if not called by an address with WITHDRAWER_ROLE. The destination is
    ///      always `IMMUTABLE_RECOVERY_VAULT` and cannot be overridden by the caller.
    ///
    /// @param asset  The asset to withdraw.
    /// @param amount The amount to withdraw.
    function emergencyWithdraw(address asset, uint256 amount) external onlyRole(WITHDRAWER_ROLE) {
        emit EmergencyWithdrawal(asset, IMMUTABLE_RECOVERY_VAULT, amount);
        _withdraw(asset, IMMUTABLE_RECOVERY_VAULT, amount);
    }

    /// @notice Pauses user withdrawals.
    ///
    /// @dev Reverts if not called by an address with PAUSER_ROLE.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpauses user withdrawals.
    ///
    /// @dev Reverts if not called by an address with PAUSER_ROLE.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Returns whether the `withdrawRequest` signature is valid for the given `account`.
    ///
    /// @dev Does not validate nonce or expiry.
    ///
    /// @param account         The account address.
    /// @param withdrawRequest The withdraw request.
    ///
    /// @return `true` if the signature is valid, else `false`.
    function isValidWithdrawSignature(address account, WithdrawRequest memory withdrawRequest)
        public
        view
        returns (bool)
    {
        bytes32 hash = getHash(account, withdrawRequest);
        address signer = ECDSA.tryRecover(hash, withdrawRequest.signature);

        if (signer == address(0)) {
            return false;
        }

        return hasRole(AUTHORIZER_ROLE, signer);
    }

    /// @notice Returns the hash to be signed for a given `account` and `withdrawRequest` pair.
    ///
    /// @dev Returns an EIP-191 compliant Ethereum Signed Message (version 0x45), see
    ///      https://eips.ethereum.org/EIPS/eip-191.
    ///
    /// @param account         The account address.
    /// @param withdrawRequest The withdraw request.
    ///
    /// @return The hash to be signed for the given `account` and `withdrawRequest`.
    function getHash(address account, WithdrawRequest memory withdrawRequest) public view returns (bytes32) {
        return SignatureCheckerLib.toEthSignedMessageHash(
            abi.encode(
                address(this),
                account,
                block.chainid,
                withdrawRequest.asset,
                withdrawRequest.amount,
                withdrawRequest.nonce,
                withdrawRequest.expiry
            )
        );
    }

    /// @notice Returns whether the `nonce` has been used by the given `account`.
    ///
    /// @param account The account address.
    /// @param nonce   The nonce to check.
    ///
    /// @return `true` if the nonce has already been used by the account, else `false`.
    function nonceUsed(address account, uint256 nonce) external view returns (bool) {
        return _nonceUsed[nonce][account];
    }

    /// @notice Validate the `withdrawRequest` against the given `account`.
    ///
    /// @param account         The account address.
    /// @param withdrawRequest The withdraw request to validate.
    function _validateRequest(address account, WithdrawRequest memory withdrawRequest) internal {
        if (_nonceUsed[withdrawRequest.nonce][account]) {
            revert InvalidNonce(withdrawRequest.nonce);
        }

        _nonceUsed[withdrawRequest.nonce][account] = true;

        emit JustInTimeFundingWithdrawal(account, withdrawRequest.asset, withdrawRequest.amount, withdrawRequest.nonce);
    }

    /// @notice Withdraws funds from this contract.
    ///
    /// @dev Uses `forceSafeTransferETH` for native ETH to guarantee delivery even if the
    ///      recipient is a contract that reverts on receive (e.g., during ERC-4337 bundled
    ///      user operations where the recipient may be a smart contract wallet).
    ///
    /// @param asset  The asset to withdraw.
    /// @param to     The beneficiary address.
    /// @param amount The amount to withdraw.
    function _withdraw(address asset, address to, uint256 amount) internal {
        if (asset == address(0)) {
            SafeTransferLib.forceSafeTransferETH(to, amount);
        } else {
            SafeTransferLib.safeTransfer(asset, to, amount);
        }
    }
}

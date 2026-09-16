## Title

Vault losses are permanently forgiven by the `lastTotalAssets` baseline reset, so later gains are mis-booked as revenue and paid out of user collateral backing

### Severity

Medium

### Description

`CollateralManager` derives revenue from a single high-water mark per collateral, `lastTotalAssets[collateral]`, compared against the live value of the manager's vault shares.

`src/CollateralManager.sol::_getRevenue()`:

```solidity
function _getRevenue(address collateral, IERC4626 vault) internal view returns (uint256 revenue) {
    uint256 previousRevenue = pendingRevenue[collateral];
    uint256 totalAssets = _totalAssets(vault);
    uint256 lastTotal = lastTotalAssets[collateral];
    if (totalAssets > lastTotal) {
        uint256 gain = totalAssets - lastTotal;
        revenue = previousRevenue + gain;
    } else if (totalAssets < lastTotal) {
        uint256 loss = lastTotal - totalAssets;
        revenue = loss >= previousRevenue ? 0 : previousRevenue - loss;   // <-- deficit discarded
    } else {
        revenue = previousRevenue;
    }
}
```

When the underlying ERC4626 vault loses value (bad debt, exit fee, withdrawal slippage), the loss is only netted against `pendingRevenue` and floored at zero. The portion of the loss that exceeds accrued revenue is **not recorded anywhere** â€” there is no deficit / shortfall accumulator.

Every state-mutating path then re-anchors the baseline at the *current* (post-loss) vault value rather than adjusting the previous baseline by the principal moved:

- `deposit()` â€” `lastTotalAssets[collateral] = _totalAssets(vault);`
- `withdraw()` â€” `lastTotalAssets[collateral] = _totalAssets(vault);`
- `withdrawRevenue()` â€” `lastTotalAssets[collateral] = _totalAssets(vault);`
- `convertRevenue()` â€” `lastTotalAssets[collateral] = _totalAssets(vault);`

Correct behaviour for a principal move of `amount` is `lastTotal Â± amount`. Because the baseline is instead set to `postLossAssets + amount`, the un-covered loss is permanently forgiven: the vault merely recovering to its pre-loss level is subsequently reported as *fresh* revenue by `getRevenue()`.

`withdrawRevenue()` pays that revenue out of the manager's **idle collateral balance** â€” the same balance that backs outstanding asset tokens â€” with no solvency check:

```solidity
uint256 revenue = _getRevenue(collateral, vault);
if (amount > revenue) revert ExceedsPendingRevenue();
IERC20(collateral).safeTransfer(msg.sender, amount);
```

The same mechanism silently absorbs vault withdrawal fees and exit slippage into collateral backing instead of deducting them from the revenue claim.

Concrete sequence (no actor misbehaves; curator curates and the revenue keeper collects exactly as designed):

1. Users mint against 1000e6 USDC; curator calls `deposit(USDC, 1000e6)` â†’ `lastTotalAssets = 1000e6`.
2. Vault realises a 300e6 loss. `getRevenue()` returns 0; the 300e6 deficit is not stored.
3. New users mint 300e6 more; curator calls `deposit(USDC, 300e6)`. `_getRevenue` is evaluated pre-deposit (= 0) and `lastTotalAssets` is reset to `700e6 + 300e6 = 1000e6` instead of the correct high-water mark of `1300e6`.
4. Vault recovers +300e6 (assets back to 1300e6). Cumulative vault P&L for the manager is exactly zero, yet `getRevenue()` reports 300e6.
5. Curator withdraws from the vault (crystallising `pendingRevenue = 300e6`); `RevenueModule.collect()` â†’ `withdrawRevenue(USDC, 300e6)` â†’ `withdrawToMultisig()`.
6. Manager holds 1000e6 total (idle + vault) against 1300e6 of collateral deposited by asset-token holders.

### Impact

Recovery gains that should first repair the reserve shortfall are instead exported as revenue to the `RevenueModule` and onward to the multisig. The on-chain backing reserve for asset tokens is drained by the amount of any un-covered vault loss, fee, or slippage, and the deficit can never be repaid because it is not tracked. This is a conditional value leak of user-backing collateral triggered by a realistic external event (an ERC4626 vault realising bad debt or charging an exit fee, as with Morpho-style integrations) combined with normal protocol operation.

### Proof of Concept

Run with:

```
forge test --match-path test/warden/W6.t.sol -vvv
```

`test/warden/W6.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralManager} from "../../src/CollateralManager.sol";
import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal 6-decimals collateral token
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Minimal ERC4626 vault which can realise a loss (bad debt / fee) by shipping
/// underlying assets out of the vault. Gains are simulated by transferring assets in.
contract MockVault is ERC4626 {
    using SafeERC20 for IERC20;

    address private constant SINK = address(0xdEaD);

    constructor(IERC20 asset_) ERC20("Vault USDC", "vUSDC") ERC4626(asset_) {}

    /// @notice Realise a loss: underlying leaves the vault, share price drops
    function simulateLoss(uint256 amount) external {
        IERC20(asset()).safeTransfer(SINK, amount);
    }
}

/// @notice PoC: losses in the underlying ERC4626 vault are permanently forgiven because
/// `lastTotalAssets` is re-anchored at the post-loss value on every deposit/withdraw.
/// The vault merely recovering to its previous level is then booked as fresh "revenue"
/// and paid out of the collateral backing outstanding asset tokens.
contract W6Test is Test {
    CollateralManager internal cm;
    MockUSDC internal usdc;
    MockVault internal vault;

    address internal owner = address(this);
    address internal controller = address(0xC011);
    address internal curator = address(0xCAFE);
    address internal revenueModule = address(0xBEEF);

    bytes32 internal constant DEFAULT_ADMIN = bytes32(0);

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockVault(IERC20(address(usdc)));

        CollateralManager impl = new CollateralManager();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(CollateralManager.initialize, (controller, owner)));
        cm = CollateralManager(address(proxy));

        cm.grantRole(cm.CURATOR_ROLE(), curator);
        cm.setRevenueModule(revenueModule);
        cm.addCollateral(address(usdc), address(vault));
    }

    function test_W6_exploit() public {
        // ------------------------------------------------------------------
        // 1. Users mint asset tokens: 1000e6 of collateral lands in the manager
        //    and is curated into the vault.
        // ------------------------------------------------------------------
        uint256 userCollateral = 1000e6;
        usdc.mint(address(cm), 1000e6);

        vm.prank(curator);
        cm.deposit(address(usdc), 1000e6, 0);

        assertEq(cm.lastTotalAssets(address(usdc)), 1000e6, "baseline after first deposit");
        assertEq(cm.getRevenue(address(usdc)), 0, "no revenue yet");

        // ------------------------------------------------------------------
        // 2. The vault realises a 300e6 loss. getRevenue() floors at zero and the
        //    300e6 deficit is not recorded anywhere.
        // ------------------------------------------------------------------
        vault.simulateLoss(300e6);

        assertEq(cm.getRevenue(address(usdc)), 0, "loss only floors revenue at zero");
        assertApproxEqAbs(cm.getVaultAssets(address(usdc)), 700e6, 10, "vault down 300e6");
        assertEq(cm.pendingRevenue(address(usdc)), 0, "deficit is not stored");

        // ------------------------------------------------------------------
        // 3. New users mint 300e6 more; the curator deposits it. `_getRevenue`
        //    is computed pre-deposit (= 0) and `lastTotalAssets` is then reset to
        //    the POST-LOSS value + new principal (1000e6) instead of the correct
        //    high-water mark of 1300e6 -> the 300e6 loss is permanently forgiven.
        // ------------------------------------------------------------------
        usdc.mint(address(cm), 300e6);
        userCollateral += 300e6; // 1300e6 of user collateral now backs asset tokens

        vm.prank(curator);
        cm.deposit(address(usdc), 300e6, 0);

        assertApproxEqAbs(
            cm.lastTotalAssets(address(usdc)), 1000e6, 10, "baseline re-anchored low (should be 1300e6 high-water)"
        );

        // ------------------------------------------------------------------
        // 4. The vault recovers the exact same 300e6. Cumulative vault P&L for the
        //    manager is now ZERO (1300e6 deposited, 1300e6 of assets), yet the
        //    manager reports 300e6 of "revenue".
        // ------------------------------------------------------------------
        usdc.mint(address(vault), 300e6);

        assertApproxEqAbs(cm.getVaultAssets(address(usdc)), 1300e6, 10, "vault back to principal");
        uint256 phantomRevenue = cm.getRevenue(address(usdc));
        assertApproxEqAbs(phantomRevenue, 300e6, 10, "phantom revenue booked on zero net P&L");

        // ------------------------------------------------------------------
        // 5. Curator pulls liquidity out of the vault (crystallising pendingRevenue),
        //    the RevenueModule then collects the phantom revenue.
        // ------------------------------------------------------------------
        vm.prank(curator);
        cm.withdraw(address(usdc), 320e6, type(uint256).max);

        assertApproxEqAbs(cm.pendingRevenue(address(usdc)), 300e6, 10, "phantom revenue crystallised");

        uint256 payout = cm.getRevenue(address(usdc));
        vm.prank(revenueModule);
        cm.withdrawRevenue(address(usdc), payout);

        // ------------------------------------------------------------------
        // 6. HARM: 300e6 of user collateral backing has left the protocol as
        //    non-existent revenue. The 1:1 backing invariant is broken.
        // ------------------------------------------------------------------
        assertApproxEqAbs(usdc.balanceOf(revenueModule), 300e6, 10, "revenue module paid phantom revenue");

        uint256 backing = usdc.balanceOf(address(cm)) + cm.getVaultAssets(address(usdc));

        assertLt(backing, userCollateral, "backing must cover user collateral");
        assertApproxEqAbs(backing, 1000e6, 10, "backing shrank to 1000e6");
        assertApproxEqAbs(userCollateral - backing, 300e6, 10, "300e6 of user backing leaked as revenue");
    }
}
```

### Recommendation

Two independent fixes, both recommended:

1. **Track the deficit.** Add a `lossDeficit[collateral]` accumulator in `_getRevenue()` so that a loss exceeding `pendingRevenue` is recorded rather than discarded, and require future gains to repay `lossDeficit[collateral]` in full before any amount is credited as `revenue`.

2. **Never re-anchor the baseline to the live vault value on principal moves.** In `deposit()` / `withdraw()`, adjust the previous baseline by the principal that was moved instead of overwriting it:

```solidity
// deposit
uint256 lastTotal = lastTotalAssets[collateral];
pendingRevenue[collateral] = _getRevenue(collateral, vault);
uint256 shares = vault.deposit(amount, address(this));
if (shares < minShares) revert InsufficientSharesReceived();
lastTotalAssets[collateral] = lastTotal + amount; // not _totalAssets(vault)
```

```solidity
// withdraw
uint256 lastTotal = lastTotalAssets[collateral];
pendingRevenue[collateral] = _getRevenue(collateral, vault);
uint256 shares = vault.withdraw(amount, address(this), address(this));
if (shares > maxShares) revert ExcessiveSharesRedeemed();
lastTotalAssets[collateral] = lastTotal > amount ? lastTotal - amount : 0;
```

with `lastTotal` first reduced by any loss already netted against `pendingRevenue` in the same call, and the residual loss pushed into `lossDeficit[collateral]`. Apply the same reasoning to `withdrawRevenue()` (`lastTotal - amount`) and `convertRevenue()` (baseline unchanged; only `pendingRevenue` decreases).
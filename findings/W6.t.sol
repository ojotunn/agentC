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

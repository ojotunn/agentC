// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";

contract VaultTest is Test {
    Vault vault;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vault = new Vault();
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function test_depositAndWithdraw() public {
        vm.prank(alice);
        vault.deposit{value: 1 ether}();
        assertEq(vault.balances(alice), 1 ether);

        vm.prank(alice);
        vault.withdraw(1 ether);
        assertEq(vault.balances(alice), 0);
        assertEq(vault.collectedFees(), 0.001 ether);
    }

    function test_onlyOwnerSetsFee() public {
        vm.prank(alice);
        vm.expectRevert("not owner");
        vault.setFee(50);
    }
}

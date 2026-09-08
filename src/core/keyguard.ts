import { getAddress, type Address } from "viem";

/**
 * Refuse to send from a publicly known test key.
 *
 * WHY. The Hardhat/Anvil default accounts have published private keys. Anyone
 * can sweep them, and bots do so within seconds on any chain where they hold a
 * balance. A campaign submitted from one would have its funds drained
 * mid-campaign and fail with "insufficient funds" - precisely the failure the
 * balance preflight exists to prevent, arriving after the preflight has already
 * passed. Worse for this study: on Arbitrum, a drained L2 balance produces a
 * message that queues, reaches S4, then fails on execution, which is
 * indistinguishable at a glance from sequencer non-inclusion. A swept wallet
 * would manufacture a false censorship signal.
 *
 * SCOPE. This is a small, explicit DENY-LIST, not a detector. Whether an
 * arbitrary private key is public is not a decidable question, and a generic
 * heuristic would give false negatives - which are worse than no guard, because
 * they would be trusted. This list covers the accounts anyone running a local
 * node will have lying around and might paste into .env by accident.
 *
 * SOURCE. Addresses 0-9 derived from the Hardhat/Anvil/Foundry default
 * mnemonic, "test test test test test test test test test test test junk",
 * published in the Hardhat and Foundry documentation. Derived with
 * mnemonicToAccount rather than transcribed, then recorded here as addresses so
 * no private key material enters this repository.
 *
 * NOT COVERED, deliberately: the two fixtures in this repo. dryRunAccount() in
 * protocols/arbitrum/adapter.ts and SIZING_KEY in core/preflight.ts both use
 * account #1 on purpose - those paths sign for shape and size and never send,
 * so a public key is exactly right there. This guard applies only to the
 * real-send path.
 */

/** Hardhat / Anvil / Foundry default accounts 0-9. See the note above. */
export const WELL_KNOWN_TEST_ADDRESSES: readonly Address[] = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
];

const DENIED = new Set(WELL_KNOWN_TEST_ADDRESSES.map((a) => a.toLowerCase()));

export class WellKnownTestKeyError extends Error {
  readonly address: Address;
  constructor(address: Address, context: string) {
    super(
      `Refusing to use ${address} as the experiment sender (${context}).\n\n` +
        `This is a WELL-KNOWN PUBLIC TEST KEY - one of the Hardhat/Anvil default accounts, whose\n` +
        `private key is published in their documentation. Anyone can spend from it, and sweeper\n` +
        `bots empty these addresses within seconds of a balance appearing.\n\n` +
        `It must NEVER be funded. If it holds testnet ETH now, treat that as already lost.\n\n` +
        `A real campaign needs a FRESHLY GENERATED key that has never been published, set as\n` +
        `PRIVATE_KEY in .env. Use a testnet-only key; never reuse a mainnet key.\n\n` +
        `Why this matters beyond losing faucet ETH: a wallet drained mid-campaign fails with\n` +
        `insufficient funds after the preflight has already passed, and on Arbitrum a drained L2\n` +
        `balance makes a queued message reach S4 and then fail on execution - which looks exactly\n` +
        `like sequencer non-inclusion. That would be a fabricated censorship signal.`,
    );
    this.name = "WellKnownTestKeyError";
    this.address = address;
  }
}

/** Is this one of the published test accounts? */
export function isWellKnownTestAddress(address: Address): boolean {
  return DENIED.has(address.toLowerCase());
}

/**
 * Throw if `address` is a published test account.
 *
 * `context` names the call site so the message says where the refusal came
 * from - the CLI preflight or the adapter's last gate before signing.
 */
export function assertNotWellKnownTestKey(address: Address, context: string): void {
  if (isWellKnownTestAddress(address)) {
    throw new WellKnownTestKeyError(getAddress(address), context);
  }
}

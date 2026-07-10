import { safeReleaseAtMs } from "../src/clock.js";
import type { ReserveRequest } from "../src/store/types.js";
import type { Policy } from "../src/types.js";

export const BASE_SEPOLIA = "eip155:84532" as const;
export const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"; // Base Sepolia USDC

export function testPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    profile: "budget-only",
    windowMs: 60_000,
    perMandateCap: 1_000_000n, // 1 USDC
    envelope: {
      schemes: ["exact"],
      networks: [BASE_SEPOLIA],
      assets: [USDC],
    },
    validBeforeCeilingSeconds: 30,
    reorgMarginMs: 2_000,
    maxClockSkewMs: 5_000,
    ...overrides,
  };
}

/** Build a ReserveRequest with sensible defaults for store tests. */
export function reserveReq(
  o: Partial<ReserveRequest> & Pick<ReserveRequest, "amount" | "now">,
): ReserveRequest {
  const now = o.now;
  const validBeforeSeconds = Math.floor(now / 1000) + 30;
  return {
    principalId: o.principalId ?? "principal-1",
    mandateId: o.mandateId ?? "mandate-1",
    payTo: o.payTo ?? "0xmerchant",
    windowMs: o.windowMs ?? 60_000,
    cap: o.cap ?? 1_000_000n,
    safeReleaseAt:
      o.safeReleaseAt ?? safeReleaseAtMs(validBeforeSeconds, 2_000, 5_000),
    ...(o.aggregateCap !== undefined ? { aggregateCap: o.aggregateCap } : {}),
    ...(o.perPayeeReservationLimit !== undefined
      ? { perPayeeReservationLimit: o.perPayeeReservationLimit }
      : {}),
    amount: o.amount,
    now,
  };
}

import { InMemoryAtomicStore } from "../src/store/memory.js";
import { runAtomicStoreContract } from "./store-contract.js";

runAtomicStoreContract("G1: in-memory atomic store", () => ({
  store: new InMemoryAtomicStore(),
}));

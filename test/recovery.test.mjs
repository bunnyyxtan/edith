import { test } from "node:test";
import assert from "node:assert/strict";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { TransactionError } from "@mysten/sui/client";
import { UnaryCall, RpcError } from "@protobuf-ts/runtime-rpc";
import { readFileSync } from "node:fs";
import { provePaymentInvalidated, verifyPayment, withRetry } from "../src/sui.mjs";
import { signedTransfer } from "./chain.mjs";

const payTo = `0x${"c".repeat(64)}`;
const conflict = "H9oQdHwAc1NLF8nY5pa1FgVz6RgfSm56ZN1YXCHnJfzd";
const grpcFixture = JSON.parse(readFileSync(new URL("./fixtures/sui-recovery-grpc.json", import.meta.url), "utf8"));

// Only the network is replaced. The generated service, protobuf binary codec, read masks,
// NOT_FOUND wrapping, object mapping and effects mapping are all the installed SDK's code.
function grpcClient(data = structuredClone(grpcFixture), missingDigest, errorCode = "NOT_FOUND") {
  const requests = [];
  const transport = {
    mergeOptions: (options = {}) => options,
    unary(method, input) {
      requests.push({ method: method.name, input });
      const response = Promise.resolve().then(() => {
        if (method.name === "GetTransaction" && input.digest === missingDigest) throw new RpcError(errorCode, errorCode);
        const json = method.name === "BatchGetObjects" ? data.objects : method.name === "GetTransaction" ? data.transaction : assert.fail(`Unexpected RPC ${method.name}`);
        return method.O.fromBinary(method.O.toBinary(method.O.fromJson(json)));
      });
      return new UnaryCall(method, {}, input, Promise.resolve({}), response, Promise.resolve({ code: "OK", detail: "" }), Promise.resolve({}));
    },
    serverStreaming() { assert.fail("No streaming RPC expected"); },
    clientStreaming() { assert.fail("No client stream expected"); },
    duplex() { assert.fail("No duplex RPC expected"); },
  };
  return { client: new SuiGrpcClient({ network: "mainnet", transport }), requests };
}

async function fixture() {
  const signed = await signedTransfer({ payTo, amount: 100n });
  const gas = TransactionDataBuilder.fromBytes(signed.bytes).gasData.payment[0];
  const item = { digest: signed.digest, network: "mainnet", recovery: { network: "mainnet", transaction: signed.transaction } };
  const change = { objectId: gas.objectId, inputState: "Exists", inputVersion: gas.version, inputDigest: gas.digest,
    inputOwner: { $kind: "AddressOwner", AddressOwner: signed.payer.toSuiAddress() }, outputState: "ObjectWrite", outputVersion: "2" };
  const tx = { digest: conflict, checkpoint: "123", effects: { transactionDigest: conflict, changedObjects: [change] } };
  const client = { core: {
    getObject: async () => ({ object: { objectId: gas.objectId, previousTransaction: conflict } }),
    getTransaction: async () => ({ Transaction: tx }),
  } };
  return { signed, gas, item, change, tx, client };
}

test("recovery requires exact consumed gas input and checkpointed effects, including deletion and failed transactions", async () => {
  const { item, client, tx, change, gas } = await fixture();
  const proof = await provePaymentInvalidated(client, item);
  assert.deepEqual(proof, { kind: "gas-input-consumed", network: "mainnet", paymentDigest: item.digest,
    conflictingDigest: conflict, checkpoint: "123", gas });
  change.outputState = "DoesNotExist";
  change.outputVersion = null;
  client.core.getTransaction = async () => ({ FailedTransaction: tx });
  assert.ok(await provePaymentInvalidated(client, item));
  client.core.getObject = async () => { throw new Error("deleted object"); };
  assert.equal(await provePaymentInvalidated(client, item), null);
  assert.ok(await provePaymentInvalidated(client, item, conflict), "an operator hint works for deleted objects but still fetches effects");
});

test("recovery fails closed for missing, mismatched, ambiguous and unavailable evidence", async () => {
  const mutations = [
    (f) => { delete f.item.recovery; },
    (f) => { f.item.recovery.network = "testnet"; },
    (f) => { f.item.recovery.transaction = "bad"; },
    (f) => { f.item.digest = conflict; },
    (f) => { f.tx.checkpoint = null; },
    (f) => { f.tx.digest = "wrong"; },
    (f) => { f.tx.effects.transactionDigest = "wrong"; },
    (f) => { f.change.inputVersion = "2"; }, // later use might be AFTER the original payment
    (f) => { f.change.inputDigest = "different"; },
    (f) => { f.change.objectId = payTo; },
    (f) => { f.change.inputState = "Unknown"; },
    (f) => { f.change.inputOwner = { $kind: "Shared" }; },
    (f) => { f.change.outputState = "Unknown"; },
    (f) => { f.change.outputVersion = "1"; },
    (f) => { f.tx.effects.changedObjects = []; },
    (f) => { f.client.core.getObject = async () => ({ object: { objectId: f.gas.objectId, previousTransaction: f.item.digest } }); },
    (f) => { f.client.core.getTransaction = async () => { throw Object.assign(new Error("not found"), { code: "NOT_FOUND" }); }; },
    (f) => { f.client.core.getTransaction = async () => { throw new Error("gateway outage"); }; },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    mutate(f);
    assert.equal(await provePaymentInvalidated(f.client, f.item), null, mutate.toString());
  }
});

test("recovery uses the pinned SDK's protobuf object/effects mapping and lossless checkpoint values", async () => {
  const { item, gas } = await fixture();
  const { client, requests } = grpcClient();
  const { object } = await client.core.getObject({ objectId: gas.objectId, include: { previousTransaction: true } });
  assert.equal(object.objectId, gas.objectId);
  assert.equal(object.id, undefined, "old SDK id aliases are not the pinned contract");
  const { Transaction: tx } = await client.core.getTransaction({ digest: conflict, include: { effects: true } });
  assert.equal(tx.checkpoint, "9007199254740993", "checkpoint must not be coerced to a JS number");
  assert.equal(tx.effects.changedObjects[0].objectId, gas.objectId);
  assert.equal(tx.effects.changedObjects[0].inputVersion, "1");
  assert.equal(tx.effects.changedObjects[0].inputOwner.$kind, "AddressOwner");
  const proof = await provePaymentInvalidated(client, item);
  assert.equal(proof.checkpoint, tx.checkpoint);
  assert.deepEqual(proof.gas, gas);
  assert.ok(requests.find((r) => r.method === "BatchGetObjects").input.readMask.paths.includes("previous_transaction"));
  assert.ok(requests.find((r) => r.method === "GetTransaction").input.readMask.paths.includes("effects"));
  assert.ok(requests.find((r) => r.method === "GetTransaction").input.readMask.paths.includes("checkpoint"));
});

test("SDK integration rejects absent checkpoint/effects, missing gas references, and later consumption", async () => {
  const { item } = await fixture();
  for (const mutate of [
    (data) => { delete data.transaction.transaction.checkpoint; },
    (data) => { delete data.transaction.transaction.effects; },
    (data) => { delete data.transaction.transaction.effects.changedObjects[0].objectId; },
    (data) => { delete data.transaction.transaction.effects.changedObjects[0].inputDigest; },
    (data) => { data.transaction.transaction.effects.changedObjects[0].inputVersion = "2"; },
    (data) => { data.transaction.transaction.effects.transactionDigest = item.digest; },
  ]) {
    const data = structuredClone(grpcFixture);
    mutate(data);
    assert.equal(await provePaymentInvalidated(grpcClient(data).client, item), null, mutate.toString());
  }
  const data = structuredClone(grpcFixture);
  data.transaction.transaction.effects.status = { success: false, error: { kind: "INSUFFICIENT_GAS", description: "Insufficient gas" } };
  const { client } = grpcClient(data);
  const result = await client.core.getTransaction({ digest: conflict, include: { effects: true } });
  assert.equal(result.$kind, "FailedTransaction");
  assert.ok(await provePaymentInvalidated(client, item), "a checkpointed failed transaction still consumes its gas input");
  const deleted = structuredClone(grpcFixture);
  const change = deleted.transaction.transaction.effects.changedObjects[0];
  change.outputState = "OUTPUT_OBJECT_STATE_DOES_NOT_EXIST";
  change.idOperation = "DELETED";
  delete change.outputVersion;
  delete change.outputDigest;
  delete change.outputOwner;
  assert.ok(await provePaymentInvalidated(grpcClient(deleted).client, item, conflict));
});

test("the SDK's wrapped NOT_FOUND reaches recovery and retries, while outages do not become evidence", async () => {
  const { item } = await fixture();
  const { client, requests } = grpcClient(undefined, item.digest);
  await assert.rejects(client.core.getTransaction({ digest: item.digest }), (err) => err instanceof TransactionError && err.reason === "notFound" && err.code === undefined);
  const verified = await verifyPayment(client, item.digest, { payTo, minAmount: 100n });
  assert.equal(verified.status, "not_found");
  assert.equal(requests.filter((r) => r.input.digest === item.digest).length, 5, "lookup plus four verification attempts");
  assert.ok(await provePaymentInvalidated(client, item));
  let attempts = 0;
  await assert.rejects(withRetry(async () => { attempts++; throw new TransactionError("notFound", item.digest); }, { codes: new Set(["UNAVAILABLE"]), baseDelayMs: 1 }), TransactionError);
  assert.equal(attempts, 1, "submission-style retry policies still exclude missing transactions");
  const down = grpcClient(undefined, item.digest, "UNAVAILABLE");
  await assert.rejects(verifyPayment(down.client, item.digest, { payTo, minAmount: 100n }), (err) => err.code === "UNAVAILABLE");
  assert.equal(down.requests.length, 4);
  assert.equal(await provePaymentInvalidated(grpcClient(undefined, conflict, "UNAVAILABLE").client, item), null);
});

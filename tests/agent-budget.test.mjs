import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as net from "node:net";
import test from "node:test";

import { acquireChildSlot } from "../extensions/subagent/agent-budget.ts";
import { startApprovalServer } from "../extensions/subagent/approval-server.ts";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertPending(promise) {
  const marker = Symbol("pending");
  const result = await Promise.race([promise, delay(50).then(() => marker)]);
  assert.equal(result, marker);
}

function rawAcquire(socketPath, agent = "raw") {
  const id = crypto.randomUUID();
  const socket = net.connect(socketPath);
  let buffer = "";
  const granted = new Promise((resolve, reject) => {
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "acquire", id, agent })}\n`);
    });
    socket.on("data", (data) => {
      buffer += data.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });
  return { socket, granted };
}

function approvalServer(select) {
  return startApprovalServer({ select }, { maxLiveChildren: 2, acquireTimeoutMs: 1000 });
}

test("child budget grants under capacity, queues FIFO, and releases on close", async () => {
  const server = startApprovalServer({}, { maxLiveChildren: 2, acquireTimeoutMs: 1000 });
  try {
    const first = acquireChildSlot(server.socketPath, "one", 1000);
    const second = acquireChildSlot(server.socketPath, "two", 1000);
    const third = acquireChildSlot(server.socketPath, "three", 1000);

    const [lease1, lease2] = await Promise.all([first, second]);
    assert.equal(lease1.granted, true);
    assert.equal(lease2.granted, true);
    await assertPending(third);

    lease1.release();
    const lease3 = await third;
    assert.equal(lease3.granted, true);

    lease2.release();
    lease3.release();
  } finally {
    server.close();
  }
});

test("child budget grants multiple waiters in FIFO order", async () => {
  const server = startApprovalServer({}, { maxLiveChildren: 1, acquireTimeoutMs: 1000 });
  try {
    const holder = await acquireChildSlot(server.socketPath, "holder", 1000);
    assert.equal(holder.granted, true);

    const order = [];
    const firstWaiter = acquireChildSlot(server.socketPath, "waiter-1", 1000).then((lease) => {
      order.push("waiter-1");
      return lease;
    });
    const secondWaiter = acquireChildSlot(server.socketPath, "waiter-2", 1000).then((lease) => {
      order.push("waiter-2");
      return lease;
    });
    await assertPending(firstWaiter);
    await assertPending(secondWaiter);

    holder.release();
    const firstLease = await firstWaiter;
    assert.equal(firstLease.granted, true);
    assert.deepEqual(order, ["waiter-1"]);
    await assertPending(secondWaiter);

    firstLease.release();
    const secondLease = await secondWaiter;
    assert.equal(secondLease.granted, true);
    assert.deepEqual(order, ["waiter-1", "waiter-2"]);
    secondLease.release();
  } finally {
    server.close();
  }
});

test("queued client disconnect is removed before it can consume a freed slot", async () => {
  const server = startApprovalServer({}, { maxLiveChildren: 1, acquireTimeoutMs: 1000 });
  try {
    const holder = await acquireChildSlot(server.socketPath, "holder", 1000);
    assert.equal(holder.granted, true);

    const disconnected = rawAcquire(server.socketPath, "disconnect");
    disconnected.granted.catch(() => undefined);
    await delay(25);
    disconnected.socket.destroy();

    const waiter = acquireChildSlot(server.socketPath, "waiter", 1000);
    await assertPending(waiter);
    holder.release();

    const waiterLease = await waiter;
    assert.equal(waiterLease.granted, true);
    waiterLease.release();
  } finally {
    server.close();
  }
});

test("four holders make a nested request time out with budget exhausted", async () => {
  const server = startApprovalServer({}, { maxLiveChildren: 4, acquireTimeoutMs: 50 });
  try {
    const holders = await Promise.all([1, 2, 3, 4].map((index) => acquireChildSlot(server.socketPath, `holder-${index}`, 1000)));
    for (const holder of holders) assert.equal(holder.granted, true);

    const nested = await acquireChildSlot(server.socketPath, "nested", 1000);
    assert.deepEqual(nested, { granted: false, reason: "budget exhausted" });

    for (const holder of holders) holder.release();
  } finally {
    server.close();
  }
});

test("child budget times out queued acquire requests", async () => {
  const server = startApprovalServer({}, { maxLiveChildren: 1, acquireTimeoutMs: 50 });
  try {
    const first = await acquireChildSlot(server.socketPath, "one", 1000);
    assert.equal(first.granted, true);

    const second = await acquireChildSlot(server.socketPath, "two", 1000);
    assert.deepEqual(second, { granted: false, reason: "budget exhausted" });

    first.release();
  } finally {
    server.close();
  }
});

test("destroyed acquire socket frees the held slot without explicit release", async () => {
  const server = startApprovalServer({}, { maxLiveChildren: 1, acquireTimeoutMs: 1000 });
  try {
    const first = rawAcquire(server.socketPath, "holder");
    const firstReply = await first.granted;
    assert.deepEqual(firstReply, { id: firstReply.id, granted: true });

    const queued = acquireChildSlot(server.socketPath, "queued", 1000);
    await assertPending(queued);

    first.socket.destroy();
    const queuedLease = await queued;
    assert.equal(queuedLease.granted, true);
    queuedLease.release();
  } finally {
    server.close();
  }
});

test("approval messages with explicit type still round-trip", async () => {
  const server = approvalServer(async () => "Allow");
  try {
    const id = crypto.randomUUID();
    const socket = net.connect(server.socketPath);
    let buffer = "";
    const reply = await new Promise((resolve, reject) => {
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "approval", id, agent: "worker", toolName: "bash", input: { command: "rm -rf build" }, reasons: ["recursive/forced rm"] })}\n`);
      });
      socket.on("data", (data) => {
        buffer += data.toString();
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        resolve(JSON.parse(buffer.slice(0, newline)));
      });
      socket.on("error", reject);
    });

    assert.deepEqual(reply, { id, allow: true });
  } finally {
    server.close();
  }
});

test("status_count messages are forwarded without a reply", async () => {
  const seen = [];
  const server = startApprovalServer({}, { maxLiveChildren: 2, acquireTimeoutMs: 1000, onStatusCount: (sessionId, nestedCount) => seen.push({ sessionId, nestedCount }) });
  try {
    const socket = net.connect(server.socketPath);
    await new Promise((resolve, reject) => {
      socket.on("connect", () => {
        socket.end(`${JSON.stringify({ type: "status_count", sessionId: "child-1", nestedCount: 2 })}\n`);
      });
      socket.on("close", resolve);
      socket.on("error", reject);
    });

    assert.deepEqual(seen, [{ sessionId: "child-1", nestedCount: 2 }]);
  } finally {
    server.close();
  }
});

test("approval messages are denied when no UI callback exists", async () => {
  const server = startApprovalServer({}, { maxLiveChildren: 2, acquireTimeoutMs: 1000 });
  try {
    const id = crypto.randomUUID();
    const socket = net.connect(server.socketPath);
    let buffer = "";
    const reply = await new Promise((resolve, reject) => {
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "approval", id, agent: "worker", toolName: "bash", input: { command: "sudo true" }, reasons: ["sudo"] })}\n`);
      });
      socket.on("data", (data) => {
        buffer += data.toString();
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        resolve(JSON.parse(buffer.slice(0, newline)));
      });
      socket.on("error", reject);
    });

    assert.deepEqual(reply, { id, allow: false });
  } finally {
    server.close();
  }
});

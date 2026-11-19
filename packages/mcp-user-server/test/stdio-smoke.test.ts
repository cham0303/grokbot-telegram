import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

describe("bundled user stdio server", () => {
  it("starts over stdio and lists user-account tools without credentials", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [dist],
      env: {
        PATH: process.env.PATH ?? "",
      },
    });
    const client = new Client({ name: "stdio-smoke", version: "0.0.0" });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      assert.ok(names.includes("auth_status"));
      assert.ok(names.includes("send_message"));
      assert.ok(names.includes("list_dialogs"));
      assert.ok(names.includes("get_messages"));
      assert.ok(names.includes("start_login"));
      assert.ok(names.includes("cancel_login"));
    } finally {
      await client.close();
    }
  });

  it("SE-2 stdout lines are JSON-RPC during initialize and a tool call", async () => {
    const child = spawn(process.execPath, [dist], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) lines.push(line);
        nl = buffer.indexOf("\n");
      }
    });
    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const waitFor = async (predicate: () => boolean) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > 5000) {
          throw new Error(`timed out waiting for stdout: ${lines.join(" | ")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "stdio-clean", version: "0" },
        },
      });
      await waitFor(() => lines.some((line) => line.includes('"id":1')));
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "auth_status", arguments: {} } });
      await waitFor(() => lines.some((line) => line.includes('"id":2')));
      for (const line of lines) {
        const parsed = JSON.parse(line) as { jsonrpc?: string };
        assert.equal(parsed.jsonrpc, "2.0", line);
      }
      assert.ok(lines.length >= 2);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

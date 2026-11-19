import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { pendingLoginPath } from "../src/pending-login.js";
import { createTelegramUserMcpServer } from "../src/server.js";
import { writeSessionString } from "../src/credentials.js";
import type { LoginTokenResult, TelegramUserClient, UserInfo } from "../src/types.js";

const SESSION = "<SESSION_CANARY>";
const OTP = "<OTP_CANARY>";
const PASSWORD = "<PASSWORD_CANARY>";
const APIHASH = "<APIHASH_CANARY>";
const TOKEN = "<TOKEN_CANARY>";
const LOGINURL = `tg://login?token=${TOKEN}`;
const GOOD = "GOOD-SESSION-BYTES";

const keys = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_SESSION",
  "TELEGRAM_SESSION_PATH",
];

afterEach(() => {
  for (const key of keys) delete process.env[key];
});

const me: UserInfo = {
  id: "42",
  username: "ada",
  firstName: "Ada",
  phone: "0000000",
  isBot: false,
};

type Calls = { disconnects: number; imports: Buffer[] };

function userClient(overrides: Partial<TelegramUserClient> = {}): {
  client: TelegramUserClient;
  calls: Calls;
} {
  const calls: Calls = { disconnects: 0, imports: [] };
  const client: TelegramUserClient = {
    connect: async () => {},
    disconnect: async () => {
      calls.disconnects += 1;
    },
    isAuthorized: async () => true,
    getMe: async () => me,
    listDialogs: async () => [],
    listForumTopics: async () => [],
    getMessages: async () => [],
    sendMessage: async (chat, text) => ({ id: 1, chatId: chat, text }),
    sendCode: async () => ({ phoneCodeHash: "hash-1", isCodeViaApp: true }),
    signIn: async () => me,
    signInWithPassword: async () => me,
    exportLoginToken: async () => ({
      kind: "token",
      token: Buffer.from("qr-one"),
      expires: Math.floor(Date.now() / 1000) + 30,
    }),
    importLoginToken: async (token) => {
      calls.imports.push(token);
      return { kind: "success", user: me };
    },
    switchDc: async () => {},
    onLoginToken: () => () => {},
    exportSession: () => SESSION,
    ...overrides,
  };
  return { client, calls };
}

function isolate(): { dir: string; sessionPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "tg-accept-"));
  const sessionPath = join(dir, "user.session");
  process.env.TELEGRAM_SESSION_PATH = sessionPath;
  process.env.TELEGRAM_API_ID = "12345";
  process.env.TELEGRAM_API_HASH = "abc";
  delete process.env.TELEGRAM_SESSION;
  return { dir, sessionPath };
}

function seed(sessionPath: string, bytes = GOOD) {
  mkdirSync(join(sessionPath, ".."), { recursive: true });
  writeFileSync(sessionPath, bytes, { mode: 0o600 });
}

async function connect(
  client: TelegramUserClient,
  connectTimeoutMs = 20_000,
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createTelegramUserMcpServer({
    createClient: () => client,
    connectTimeoutMs,
  });
  const mcp = new Client({ name: "accept", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return { mcp, server };
}

type Content = { type: string; text?: string; data?: string };

async function tool(
  mcp: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; content: Content[]; logs: string }> {
  const logs: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  const wrap =
    (method: string, fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      logs.push(`${method}:${args.map(String).join(" ")}`);
      fn(...args);
    };
  console.log = wrap("log", original.log);
  console.info = wrap("info", original.info);
  console.debug = wrap("debug", original.debug);
  console.warn = wrap("warn", original.warn);
  console.error = wrap("error", original.error);
  try {
    const result = await mcp.callTool({ name, arguments: args });
    const content = result.content as Content[];
    const text = content.map((block) => block.text ?? "").join("\n");
    return { isError: result.isError ?? false, text, content, logs: logs.join("\n") };
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function assertSecretsAbsent(text: string, allowQr = false) {
  for (const secret of [SESSION, OTP, PASSWORD, APIHASH]) {
    assert.equal(text.includes(secret), false, `secret leaked: ${secret} in ${text}`);
  }
  if (!allowQr) {
    assert.equal(text.includes(TOKEN), false, text);
    assert.equal(text.includes("tg://login"), false, text);
  }
}

function passwordNeeded(): Error {
  return Object.assign(new Error("SESSION_PASSWORD_NEEDED"), {
    errorMessage: "SESSION_PASSWORD_NEEDED",
  });
}

describe("acceptance login corrections", () => {
  it("ES-1 auth_status on a valid session omits the session string", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, SESSION);
    const { client, calls } = userClient();
    const { mcp, server } = await connect(client);
    try {
      const result = await tool(mcp, "auth_status");
      assert.equal(result.isError, false, result.text);
      const parsed = JSON.parse(result.text) as {
        authorized: boolean;
        me?: UserInfo;
        session?: string;
      };
      assert.equal(parsed.authorized, true);
      assert.equal(parsed.session, undefined);
      // Residual gap: profile fields are still returned. No host mask exists.
      assert.equal(parsed.me?.phone, "0000000");
      assert.equal(parsed.me?.id, "42");
      assertSecretsAbsent(result.text + result.logs);
      assert.equal(readFileSync(sessionPath, "utf8"), SESSION);
      assert.equal(calls.disconnects, 0);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ES-2 invalid session is auth_invalid and the file stays", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const before = statSync(sessionPath).mtimeMs;
    const { client, calls } = userClient({
      isAuthorized: async () => {
        throw Object.assign(new Error("AUTH_KEY_UNREGISTERED"), {
          errorMessage: "AUTH_KEY_UNREGISTERED",
        });
      },
    });
    const { mcp, server } = await connect(client);
    try {
      const result = await tool(mcp, "auth_status");
      assert.equal(result.isError, true, result.text);
      const parsed = JSON.parse(result.text) as { code: string; message: string };
      assert.equal(parsed.code, "auth_invalid");
      assert.notEqual(parsed.code, "timeout");
      assertSecretsAbsent(result.text + result.logs);
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assert.equal(statSync(sessionPath).mtimeMs, before);
      assert.equal(calls.disconnects, 0);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ES-3 a hung connect is timeout, not logged-out", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const { client, calls } = userClient({
      connect: () => new Promise(() => {}),
    });
    const { mcp, server } = await connect(client, 30);
    try {
      const result = await Promise.race([
        tool(mcp, "auth_status"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("tool hung")), 1000),
        ),
      ]);
      assert.equal(result.isError, true, result.text);
      const parsed = JSON.parse(result.text) as { code: string };
      assert.equal(parsed.code, "timeout");
      assert.notEqual(parsed.code, "auth_invalid");
      assert.notEqual(parsed.code, "not_authorized");
      assertSecretsAbsent(result.text + result.logs);
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assert.equal(calls.disconnects, 0);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ES-4 timeout, auth failure, and cancel leave the good session", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const { client } = userClient({
      isAuthorized: async () => false,
      connect: async () => {},
    });
    const { mcp, server } = await connect(client);
    try {
      const started = await tool(mcp, "start_login", { phone: "+10000000000" });
      assert.equal(started.isError, false, started.text);
      const cancelled = await tool(mcp, "cancel_login");
      assert.equal(cancelled.isError, false, cancelled.text);
      assert.equal(JSON.parse(cancelled.text).code, "cancelled");
      const completed = await tool(mcp, "complete_login", { code: OTP });
      assert.equal(JSON.parse(completed.text).code, "cancelled");
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assertSecretsAbsent(started.text + cancelled.text + completed.text + completed.logs);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PA-1 PA-2 PA-3 successful save is atomic 0600/0700 and failure does not replace", async () => {
    const { dir, sessionPath } = isolate();
    writeSessionString(GOOD);
    assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.throws(
      () => writeSessionString("PARTIAL", { beforeRename: () => { throw new Error("crash"); } }),
      /crash/,
    );
    assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
    assert.equal(readdirSync(dir).some((name) => name.includes(".tmp-")), false);
    const { client } = userClient({ isAuthorized: async () => false });
    const { mcp, server } = await connect(client);
    try {
      await tool(mcp, "start_login", { phone: "+10000000000" });
      const done = await tool(mcp, "complete_login", { code: OTP });
      assert.equal(done.isError, false, done.text);
      const parsed = JSON.parse(done.text) as { session?: string; session_saved?: boolean };
      assert.equal(parsed.session_saved, true);
      assert.equal(parsed.session, undefined);
      assert.equal(readFileSync(sessionPath, "utf8"), SESSION);
      assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
      assertSecretsAbsent(done.text + done.logs);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("QR-1 already authorized issues no QR and no session string", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const { client, calls } = userClient({ isAuthorized: async () => true });
    const { mcp, server } = await connect(client);
    try {
      const result = await tool(mcp, "start_qr_login");
      assert.equal(result.isError, false, result.text);
      const parsed = JSON.parse(result.text) as {
        already_authorized?: boolean;
        code?: string;
        session?: string;
        login_url?: string;
      };
      assert.equal(parsed.already_authorized, true);
      assert.equal(parsed.code, "already_authorized");
      assert.equal(parsed.login_url, undefined);
      assert.equal(parsed.session, undefined);
      assert.equal(result.content.some((block) => block.type === "image"), false);
      assert.equal(existsSync(pendingLoginPath()), false);
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assert.equal(calls.disconnects, 0);
      assertSecretsAbsent(result.text + result.logs);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("QR-2 QR-3 same-process start rotates on complete and expires at zero", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const tokens: LoginTokenResult[] = [
      { kind: "token", token: Buffer.from(TOKEN), expires: 1 },
      {
        kind: "token",
        token: Buffer.from("second-token"),
        expires: Math.floor(Date.now() / 1000) + 30,
      },
    ];
    const { client, calls } = userClient({
      isAuthorized: async () => false,
      exportLoginToken: async () => {
        const next = tokens.shift();
        if (!next) throw new Error("no token");
        return next;
      },
    });
    const { mcp, server } = await connect(client);
    try {
      const started = await tool(mcp, "start_qr_login");
      assert.equal(started.isError, false, started.text);
      assert.equal(existsSync(pendingLoginPath()), false);
      assert.match(started.text, /tg:\/\/login\?token=/);
      assert.equal(started.content[0]?.type, "image");
      const first = (JSON.parse(started.content.find((block) => block.text)?.text ?? "") as {
        login_url: string;
        expires_in_seconds: number;
      });
      assert.equal(first.expires_in_seconds, 0);
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      const completed = await tool(mcp, "complete_qr_login", { wait_ms: 0 });
      assert.equal(completed.isError, false, completed.text);
      const second = JSON.parse(
        completed.content.find((block) => block.text)?.text ?? "",
      ) as { login_url?: string; waiting?: boolean };
      assert.equal(second.waiting, true);
      assert.ok(second.login_url);
      assert.notEqual(second.login_url, first.login_url);
      assert.equal(
        calls.imports.some((token) => token.equals(Buffer.from(TOKEN))),
        false,
      );
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assertSecretsAbsent(started.logs + completed.logs);
      assert.equal(started.text.includes(SESSION), false);
      assert.equal(completed.text.includes(SESSION), false);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("QR-4 a new process cannot redeem the previous QR token", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const firstToken = Buffer.from("process-1-token");
    const { client: firstClient } = userClient({
      isAuthorized: async () => false,
      exportLoginToken: async () => ({
        kind: "token",
        token: firstToken,
        expires: 99,
      }),
    });
    const first = await connect(firstClient);
    const started = await tool(first.mcp, "start_qr_login");
    assert.equal(existsSync(pendingLoginPath()), false);
    assert.match(started.text, /process-1-token|tg:\/\/login/);
    await first.mcp.close();
    await first.server.close();

    const imported: Buffer[] = [];
    const { client: secondClient } = userClient({
      isAuthorized: async () => false,
      exportLoginToken: async () => ({
        kind: "token",
        token: Buffer.from("process-2-token"),
        expires: 99,
      }),
      importLoginToken: async (token) => {
        imported.push(token);
        return { kind: "success", user: me };
      },
    });
    const second = await connect(secondClient);
    try {
      const completed = await tool(second.mcp, "complete_qr_login", { wait_ms: 0 });
      assert.equal(completed.isError, false, completed.text);
      const parsed = JSON.parse(
        completed.content.find((block) => block.text)?.text ?? completed.text,
      ) as { login_url?: string };
      assert.ok(parsed.login_url);
      assert.equal(parsed.login_url.includes("process-1-token"), false);
      assert.equal(
        imported.some((token) => token.equals(firstToken)),
        false,
      );
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
    } finally {
      await second.mcp.close();
      await second.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("QR-5 cancel is structured and does not overwrite the session", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const { client, calls } = userClient({ isAuthorized: async () => false });
    const { mcp, server } = await connect(client);
    try {
      await tool(mcp, "start_qr_login");
      const cancelled = await tool(mcp, "cancel_login");
      const parsed = JSON.parse(cancelled.text) as { code: string; cancelled: boolean };
      assert.equal(parsed.code, "cancelled");
      assert.equal(parsed.cancelled, true);
      const again = await tool(mcp, "complete_qr_login", { wait_ms: 0 });
      assert.equal(JSON.parse(again.text).code, "cancelled");
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assert.equal(calls.disconnects, 0);
      assertSecretsAbsent(cancelled.text + again.text + again.logs);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("QR-5 cancel is visible to a later process", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const starter = await connect(userClient({ isAuthorized: async () => false }).client);
    await tool(starter.mcp, "start_login", { phone: "+10000000000" });
    await starter.mcp.close();
    await starter.server.close();
    const canceller = await connect(userClient().client);
    const cancelled = await tool(canceller.mcp, "cancel_login");
    assert.equal(JSON.parse(cancelled.text).code, "cancelled");
    await canceller.mcp.close();
    await canceller.server.close();
    const finisher = await connect(userClient({ isAuthorized: async () => false }).client);
    try {
      const completed = await tool(finisher.mcp, "complete_login", { code: OTP });
      assert.equal(JSON.parse(completed.text).code, "cancelled");
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assertSecretsAbsent(completed.text + completed.logs);
    } finally {
      await finisher.mcp.close();
      await finisher.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2FA-1 2FA-2 phone and QR passwords complete without echoing secrets", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    let used = "";
    const { client } = userClient({
      isAuthorized: async () => false,
      signIn: async () => {
        throw passwordNeeded();
      },
      signInWithPassword: async (password) => {
        used = password;
        return me;
      },
    });
    const { mcp, server } = await connect(client);
    try {
      await tool(mcp, "start_login", { phone: "+10000000000" });
      const needed = await tool(mcp, "complete_login", { code: OTP });
      assert.equal(needed.isError, true, needed.text);
      assert.equal(JSON.parse(needed.text).code, "session_password_needed");
      assertSecretsAbsent(needed.text + needed.logs);
      const done = await tool(mcp, "complete_login", { code: OTP, password: PASSWORD });
      assert.equal(done.isError, false, done.text);
      assert.equal(used, PASSWORD);
      assert.equal(JSON.parse(done.text).session_saved, true);
      assertSecretsAbsent(done.text + done.logs);
      assert.equal(readFileSync(sessionPath, "utf8"), SESSION);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }

    const qrDir = isolate();
    seed(qrDir.sessionPath, GOOD);
    const qr = userClient({
      isAuthorized: async () => false,
      exportLoginToken: async () => {
        throw passwordNeeded();
      },
      signInWithPassword: async (password) => {
        used = password;
        return me;
      },
    });
    const qrConn = await connect(qr.client);
    try {
      const needed = await tool(qrConn.mcp, "complete_qr_login", { wait_ms: 0 });
      assert.equal(JSON.parse(needed.text).code, "session_password_needed");
      assertSecretsAbsent(needed.text + needed.logs);
      const done = await tool(qrConn.mcp, "complete_qr_login", {
        wait_ms: 0,
        password: PASSWORD,
      });
      assert.equal(done.isError, false, done.text);
      assert.equal(used, PASSWORD);
      assertSecretsAbsent(done.text + done.logs);
    } finally {
      await qrConn.mcp.close();
      await qrConn.server.close();
      rmSync(qrDir.dir, { recursive: true, force: true });
    }
  });

  it("CC-1 duplicate auth key is structured and concurrent writes are not torn", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    const { client, calls } = userClient({
      connect: async () => {
        throw Object.assign(new Error("AUTH_KEY_DUPLICATED"), {
          errorMessage: "AUTH_KEY_DUPLICATED",
        });
      },
    });
    const { mcp, server } = await connect(client);
    try {
      const result = await tool(mcp, "auth_status");
      assert.equal(JSON.parse(result.text).code, "auth_key_duplicated");
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assert.equal(calls.disconnects, 0);
      assertSecretsAbsent(result.text + result.logs);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }

    const lockDir = mkdtempSync(join(tmpdir(), "tg-lock-"));
    const locked = join(lockDir, "user.session");
    process.env.TELEGRAM_SESSION_PATH = locked;
    writeFileSync(locked, GOOD);
    const fd = openSync(`${locked}.lock`, "wx", 0o600);
    writeSync(fd, "held\n");
    try {
      assert.throws(
        () => writeSessionString("OTHER", { waitMs: 40, staleMs: 60_000 }),
        /session file lock/,
      );
      assert.equal(readFileSync(locked, "utf8"), GOOD);
    } finally {
      closeSync(fd);
      rmSync(lockDir, { recursive: true, force: true });
    }

    const raceDir = mkdtempSync(join(tmpdir(), "tg-race-"));
    const racePath = join(raceDir, "user.session");
    const left = `A${"a".repeat(180)}`;
    const right = `B${"b".repeat(180)}`;
    const cwd = dirname(fileURLToPath(import.meta.url));
    const packageDir = join(cwd, "..");
    async function writer(payload: string) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--eval",
            'import { writeSessionString } from "./src/credentials.ts"; writeSessionString(process.env.PAYLOAD ?? "");',
          ],
          {
            cwd: packageDir,
            env: {
              PATH: process.env.PATH ?? "",
              PAYLOAD: payload,
              TELEGRAM_SESSION_PATH: racePath,
            },
          },
        );
        let err = "";
        child.stderr.on("data", (chunk) => {
          err += String(chunk);
        });
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`writer ${code}: ${err}`));
        });
      });
    }
    await Promise.all([writer(left), writer(right)]);
    const finalBytes = readFileSync(racePath, "utf8");
    assert.ok(finalBytes === left || finalBytes === right, finalBytes);
    rmSync(raceDir, { recursive: true, force: true });
  });

  it("CC-2 overlapping QR starts do not clobber a good session or return a stale code as current", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, GOOD);
    let n = 0;
    const { client } = userClient({
      isAuthorized: async () => false,
      exportLoginToken: async () => {
        n += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          kind: "token" as const,
          token: Buffer.from(`tok-${n}`),
          expires: 99,
        };
      },
    });
    const { mcp, server } = await connect(client);
    try {
      const [a, b] = await Promise.all([
        tool(mcp, "start_qr_login"),
        tool(mcp, "start_qr_login"),
      ]);
      const texts = [a.text, b.text];
      const urls = texts
        .map((text) => {
          try {
            const block = JSON.parse(text) as { login_url?: string };
            return block.login_url;
          } catch {
            const match = text.match(/tg:\/\/login\?token=[^\s"]+/);
            return match?.[0];
          }
        })
        .filter((url): url is string => Boolean(url));
      assert.ok(urls.length >= 1, texts.join("\n---\n"));
      assert.equal(new Set(urls).size, urls.length);
      assert.equal(readFileSync(sessionPath, "utf8"), GOOD);
      assertSecretsAbsent(a.logs + b.logs);
      for (const text of texts) assert.equal(text.includes(SESSION), false);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SE-1 codes are distinct for timeout, auth_invalid, cancelled, already_authorized, and 2FA", async () => {
    const { dir } = isolate();
    const codes: string[] = [];
    const timeoutClient = userClient({ connect: () => new Promise(() => {}) });
    const timeoutConn = await connect(timeoutClient.client, 20);
    const timeout = await tool(timeoutConn.mcp, "get_me");
    codes.push(JSON.parse(timeout.text).code);
    await timeoutConn.mcp.close();
    await timeoutConn.server.close();

    const invalid = userClient({
      connect: async () => {
        throw Object.assign(new Error("SESSION_REVOKED"), { errorMessage: "SESSION_REVOKED" });
      },
    });
    const invalidConn = await connect(invalid.client);
    codes.push(JSON.parse((await tool(invalidConn.mcp, "get_me")).text).code);
    await invalidConn.mcp.close();
    await invalidConn.server.close();

    const cancelConn = await connect(userClient().client);
    codes.push(JSON.parse((await tool(cancelConn.mcp, "cancel_login")).text).code);
    await cancelConn.mcp.close();
    await cancelConn.server.close();

    const already = await connect(userClient({ isAuthorized: async () => true }).client);
    codes.push(JSON.parse((await tool(already.mcp, "start_login", { phone: "+10000000000" })).text).code);
    await already.mcp.close();
    await already.server.close();

    const twoFa = userClient({
      isAuthorized: async () => false,
      signIn: async () => {
        throw passwordNeeded();
      },
    });
    const twoConn = await connect(twoFa.client);
    await tool(twoConn.mcp, "start_login", { phone: "+10000000000" });
    codes.push(JSON.parse((await tool(twoConn.mcp, "complete_login", { code: "1" })).text).code);
    await twoConn.mcp.close();
    await twoConn.server.close();

    assert.deepEqual(codes, [
      "timeout",
      "auth_invalid",
      "cancelled",
      "already_authorized",
      "session_password_needed",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("SC-1 SC-2 canaries stay out of errors and api_hash is not echoed", async () => {
    const { dir, sessionPath } = isolate();
    seed(sessionPath, SESSION);
    process.env.TELEGRAM_API_HASH = APIHASH;
    const { client } = userClient({
      isAuthorized: async () => false,
      exportLoginToken: async () => {
        throw new Error(`boom ${LOGINURL} ${SESSION} ${APIHASH}`);
      },
    });
    const { mcp, server } = await connect(client);
    try {
      const result = await tool(mcp, "start_qr_login");
      assert.equal(result.isError, true, result.text);
      assertSecretsAbsent(result.text + result.logs);
      const saved = await tool(mcp, "save_api_credentials", {
        api_id: "12345",
        api_hash: APIHASH,
      });
      assert.equal(saved.isError, true);
      assertSecretsAbsent(saved.text + saved.logs);
      assert.equal(readFileSync(sessionPath, "utf8"), SESSION);
    } finally {
      await mcp.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

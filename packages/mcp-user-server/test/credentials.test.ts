import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  defaultSessionPath,
  existingSessionPath,
  getUserApiCredentials,
  legacySessionPath,
  readSessionString,
  sessionSource,
  writeSessionString,
} from "../src/credentials.js";

const keys = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_SESSION",
  "TELEGRAM_SESSION_PATH",
];

// getUserApiCredentials falls back to a file next to the session, so a test
// that leaves TELEGRAM_SESSION_PATH unset reads the developer's real
// credentials out of their home directory.
let isolated: string | undefined;

beforeEach(() => {
  isolated = mkdtempSync(join(tmpdir(), "tg-isolated-"));
  process.env.TELEGRAM_SESSION_PATH = join(isolated, "user.session");
});

afterEach(() => {
  for (const key of keys) delete process.env[key];
  if (isolated !== undefined) rmSync(isolated, { recursive: true, force: true });
  isolated = undefined;
});

describe("getUserApiCredentials", () => {
  it("requires api_id and api_hash", () => {
    assert.throws(() => getUserApiCredentials(), /TELEGRAM_API_ID is missing/);
    process.env.TELEGRAM_API_ID = "${TELEGRAM_API_ID}";
    process.env.TELEGRAM_API_HASH = "abc";
    assert.throws(() => getUserApiCredentials(), /TELEGRAM_API_ID is missing/);
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "${TELEGRAM_API_HASH}";
    assert.throws(() => getUserApiCredentials(), /TELEGRAM_API_HASH is missing/);
  });

  it("parses a positive integer api_id", () => {
    process.env.TELEGRAM_API_ID = " 2040 ";
    process.env.TELEGRAM_API_HASH = "deadbeefdeadbeefdeadbeefdeadbeef";
    assert.deepEqual(getUserApiCredentials(), {
      apiId: 2040,
      apiHash: "deadbeefdeadbeefdeadbeefdeadbeef",
    });
  });
});

describe("session file", () => {
  it("prefers TELEGRAM_SESSION env over the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-session-"));
    const path = join(dir, "user.session");
    process.env.TELEGRAM_SESSION_PATH = path;
    writeSessionString("from-file-session-value");
    process.env.TELEGRAM_SESSION = "from-env-session-value";
    assert.equal(readSessionString(), "from-env-session-value");
    assert.equal(sessionSource(), "env");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and writes the session file with contents intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-session-"));
    const path = join(dir, "user.session");
    process.env.TELEGRAM_SESSION_PATH = path;
    delete process.env.TELEGRAM_SESSION;
    const written = writeSessionString("file-session-string");
    assert.equal(written, path);
    assert.equal(readSessionString(), "file-session-string");
    assert.equal(readFileSync(path, "utf8"), "file-session-string");
    assert.equal(sessionSource(), "file");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the session atomically and leaves the old file if rename does not happen", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-session-"));
    const path = join(dir, "user.session");
    process.env.TELEGRAM_SESSION_PATH = path;
    delete process.env.TELEGRAM_SESSION;
    writeSessionString("GOOD-SESSION");
    assert.throws(
      () => writeSessionString("NEW-SESSION", { beforeRename: () => { throw new Error("crash"); } }),
      /crash/,
    );
    assert.equal(readFileSync(path, "utf8"), "GOOD-SESSION");
    assert.equal(
      readdirSync(dir).some((name) => name.includes(".tmp-")),
      false,
    );
    writeSessionString("NEW-SESSION");
    assert.equal(readFileSync(path, "utf8"), "NEW-SESSION");
    assert.equal(
      readdirSync(dir).some((name) => name.includes(".tmp-") || name.endsWith(".lock")),
      false,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to replace a session with an empty string", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-session-"));
    const path = join(dir, "user.session");
    process.env.TELEGRAM_SESSION_PATH = path;
    delete process.env.TELEGRAM_SESSION;
    writeSessionString("GOOD-SESSION");
    assert.throws(() => writeSessionString("  "), /empty session/);
    assert.equal(readFileSync(path, "utf8"), "GOOD-SESSION");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("session directory rename", () => {
  it("reads a session left in the pre-rename directory", () => {
    const home = mkdtempSync(join(tmpdir(), "tg-home-"));
    const legacy = legacySessionPath(home);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "legacy-session-string", "utf8");

    assert.equal(existingSessionPath({}, home), legacy);
    assert.equal(defaultSessionPath({}, home).includes(".grokbot-telegram"), true);
    rmSync(home, { recursive: true, force: true });
  });

  it("prefers the new directory once a session exists there", () => {
    const home = mkdtempSync(join(tmpdir(), "tg-home-"));
    const legacy = legacySessionPath(home);
    const current = defaultSessionPath({}, home);
    for (const path of [legacy, current]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `session-at-${path}`, "utf8");
    }

    assert.equal(existingSessionPath({}, home), current);
    rmSync(home, { recursive: true, force: true });
  });

  it("does not fall back when TELEGRAM_SESSION_PATH names a missing file", () => {
    const home = mkdtempSync(join(tmpdir(), "tg-home-"));
    const legacy = legacySessionPath(home);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "legacy-session-string", "utf8");

    const env = { TELEGRAM_SESSION_PATH: join(home, "elsewhere.session") };
    assert.equal(existingSessionPath(env, home), null);
    rmSync(home, { recursive: true, force: true });
  });
});

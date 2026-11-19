import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loginSavedLines } from "../src/login.js";

describe("CLI login output", () => {
  it("does not include the session string", () => {
    const session = "<SESSION_CANARY>";
    const lines = loginSavedLines("ada", "/tmp/user.session");
    const text = lines.join("\n");
    assert.equal(text.includes(session), false);
    assert.match(text, /was not printed/);
    assert.match(text, /\/tmp\/user\.session/);
  });
});

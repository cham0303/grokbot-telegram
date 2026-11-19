import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { createGramJsUserClient } from "./client.js";
import { writeSessionString } from "./credentials.js";
import { safeErrorMessage } from "./redact.js";
import { isPasswordNeeded } from "./types.js";

export function loginSavedLines(who: string, path: string): string[] {
  return [
    `Logged in as ${who}.`,
    `Session written to ${path} (mode 0600). The session string was not printed.`,
    "The file is full account access. Never commit it or paste it into chat.",
  ];
}

async function main() {
  const rl = createInterface({ input, output });
  const ask = (prompt: string) => rl.question(prompt);
  const secrets = { code: "", password: "", session: "" };

  try {
    const client = createGramJsUserClient();
    await client.connect();
    if (await client.isAuthorized()) {
      const me = await client.getMe();
      secrets.session = client.exportSession();
      const path = writeSessionString(secrets.session);
      const who = me.username ? `@${me.username}` : me.firstName ?? me.id;
      console.log(`Already authorized as ${who}.`);
      for (const line of loginSavedLines(who, path).slice(1)) console.log(line);
      return;
    }

    const phone = (await ask("Phone number (+country code): ")).trim();
    const sent = await client.sendCode(phone);
    secrets.code = (
      await ask(
        sent.isCodeViaApp
          ? "Login code from the Telegram app: "
          : "Login code from SMS: ",
      )
    ).trim();

    try {
      await client.signIn(phone, sent.phoneCodeHash, secrets.code);
    } catch (err) {
      if (!isPasswordNeeded(err)) throw err;
      secrets.password = await ask("Two-step verification password: ");
      await client.signInWithPassword(secrets.password);
    }

    const me = await client.getMe();
    secrets.session = client.exportSession();
    const path = writeSessionString(secrets.session);
    const who = me.username ? `@${me.username}` : (me.firstName ?? me.id);
    for (const line of loginSavedLines(`${who} (user id ${me.id})`, path)) {
      console.log(line);
    }
  } catch (err) {
    console.error(
      safeErrorMessage(err, [secrets.code, secrets.password, secrets.session]),
    );
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  main()
    .then(() => {
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    })
    .catch((err) => {
      console.error(safeErrorMessage(err));
      process.exit(1);
    });
}

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createGramJsUserClient, qrUrl } from "./client.js";
import {
  apiCredentialsSource,
  getUserApiCredentials,
  readSessionString,
  sessionSource,
  writeApiCredentials,
  writeSessionString,
} from "./credentials.js";
import {
  clearLoginCancelled,
  clearPendingLogin,
  markLoginCancelled,
  readPendingLogin,
  takeLoginCancelled,
  writePendingLogin,
  type PendingPhone,
} from "./pending-login.js";
import {
  classifyDestination,
  noSuchChatError,
  resolveTitle,
} from "./destination.js";
import { filterDialogs } from "./dialogs.js";
import { qrPngBase64 } from "./qr.js";
import { applyDisclaimer, disclaimerText } from "./disclaimer.js";
import { safeErrorMessage } from "./redact.js";
import { CONNECT_TIMEOUT_MS, ToolFailure, toolCodeOf } from "./tool-error.js";
import {
  isExpiredLoginToken,
  isPasswordNeeded,
  type TelegramUserClient,
} from "./types.js";

const VERSION = "0.4.0";

const SESSION_SAVED_NOTE =
  "The session was saved to the session file (mode 0600) and is not included in this result. It is full access to the personal Telegram account. Never commit it or paste it into chat.";

// 2FA gap: this process is not given a host vault, a security-reference
// field, or a user-form API. `password` stays a tool argument so a synthetic
// or real Telegram 2FA challenge can still be completed. It is redacted from
// results, logs, and errors. That is not a production secret store.

// The QR image goes first so a chat host paints it immediately; the JSON that
// follows carries login_url as the fallback for hosts that show no images.
async function qrResult(loginUrl: string, payload: Record<string, unknown>) {
  const content: (
    | { type: "image"; data: string; mimeType: string }
    | { type: "text"; text: string }
  )[] = [];
  try {
    content.push({
      type: "image",
      data: await qrPngBase64(loginUrl),
      mimeType: "image/png",
    });
  } catch {
    // Rendering must never cost the user their login; the link still works.
  }
  content.push({ type: "text", text: JSON.stringify(payload, null, 2) });
  return { content };
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown, extraSecrets: Array<string | undefined> = []) {
  const message = safeErrorMessage(err, extraSecrets);
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, code: toolCodeOf(err), message }),
      },
    ],
  };
}

function cancelledResult(message: string) {
  return jsonResult({
    ok: false,
    code: "cancelled",
    cancelled: true,
    message,
  });
}

export type UserServerOptions = {
  createClient?: (session?: string) => TelegramUserClient;
  // Tests use a short value. Production stays on CONNECT_TIMEOUT_MS.
  // This bounds a hung connect. It is not a claim about any host timeout.
  connectTimeoutMs?: number;
};

export function createTelegramUserMcpServer(
  options: UserServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "telegram-user",
    version: VERSION,
  });

  const createClient = options.createClient ?? createGramJsUserClient;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  let client: TelegramUserClient | undefined;
  let connecting: Promise<TelegramUserClient> | undefined;
  let pendingPhone: PendingPhone | undefined;
  let qrUnsubscribe: (() => void) | undefined;
  let qrScanned: { promise: Promise<void>; resolve: () => void } | undefined;
  let cancelWait: (() => void) | undefined;
  let loginCancelled = false;
  // Bumped by a new attempt or by cancel so an in-flight start cannot commit
  // after the user has moved on.
  let generation = 0;
  const issuedSecrets: string[] = [];

  function secrets(...extra: Array<string | undefined>): Array<string | undefined> {
    let session: string | undefined;
    try {
      session = readSessionString() || undefined;
    } catch {
      session = undefined;
    }
    return [
      process.env.TELEGRAM_API_HASH,
      process.env.TELEGRAM_SESSION,
      session,
      ...issuedSecrets,
      ...extra,
    ];
  }

  function connectBounded(active: TelegramUserClient): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = active.connect();
    pending.catch(() => {});
    return Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolFailure(
              "timeout",
              `Telegram connect timed out after ${connectTimeoutMs}ms. The session file was not changed and the account was not logged out.`,
            ),
          );
        }, connectTimeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  function getClient(): Promise<TelegramUserClient> {
    if (!connecting) {
      connecting = (async () => {
        getUserApiCredentials();
        if (!client) {
          // No real session yet, but a phone login may be in flight from an
          // earlier process. Its pre-auth session is the auth key the pending
          // code is bound to. A QR login is not stored here.
          const resumed =
            readSessionString() === ""
              ? (readPendingLogin()?.session ?? undefined)
              : undefined;
          client = createClient(resumed);
        }
        await connectBounded(client);
        return client;
      })().finally(() => {
        connecting = undefined;
      });
    }
    return connecting;
  }

  function attemptLive(gen: number): boolean {
    return gen === generation && !loginCancelled;
  }

  function beginAttempt(): number {
    clearLoginCancelled();
    loginCancelled = false;
    return ++generation;
  }

  function cancelledNow(): boolean {
    const marked = takeLoginCancelled();
    const memory = loginCancelled;
    if (marked || memory) {
      loginCancelled = false;
      return true;
    }
    return false;
  }

  // In-memory when the process survived both calls, from disk when it did not.
  function loadPendingPhone(): PendingPhone | undefined {
    if (pendingPhone) return pendingPhone;
    const stored = readPendingLogin();
    if (stored?.phone === undefined) return undefined;
    pendingPhone = stored.phone;
    return pendingPhone;
  }

  function rememberPendingLogin(
    active: TelegramUserClient,
    kind: "phone" | "qr",
    phone?: PendingPhone,
  ): void {
    try {
      writePendingLogin({
        kind,
        session: active.exportSession(),
        startedAtMs: Date.now(),
        ...(phone === undefined ? {} : { phone }),
      });
    } catch {
      // Losing the resume file only costs a restart of the login; it must
      // never fail the call the user is actually making.
    }
  }

  function persist(active: TelegramUserClient): {
    session_saved: true;
    session_file: string;
  } {
    const session = active.exportSession();
    issuedSecrets.push(session);
    if (session.trim() === "") {
      throw new ToolFailure("error", "Refusing to save an empty session.");
    }
    const session_file = writeSessionString(session);
    return { session_saved: true, session_file };
  }

  // Telegram gives a QR token about half a minute. Callers need that as a
  // number, not a unix timestamp they have to reason about, because the whole
  // difficulty with QR in a chat is that the window closes while the code is
  // still being rendered into the conversation.
  function expiresInSeconds(expires: number): number {
    const remaining = Math.round(expires - Date.now() / 1000);
    return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
  }

  const QR_DELIVERY =
    "The scannable QR image is attached to this result — forward it to the user immediately, on its own, before any commentary. Do not render your own image and do not send login_url instead: the code dies in seconds, and anything ahead of it eats the window. login_url is only a fallback for a client that cannot show images. The user scans it in Telegram → Settings → Devices → Link Desktop Device.";


  // How many dialogs to scan when the caller named a chat by title. Deep
  // enough for a real inbox, shallow enough to stay fast.
  const TITLE_LOOKUP_LIMIT = 200;

  async function resolveDestination(
    active: TelegramUserClient,
    chat: string,
  ): Promise<{ target: string; resolved?: { id: string; title: string } }> {
    const destination = classifyDestination(chat);
    if (destination.kind === "direct") return { target: destination.target };

    const dialogs = await active.listDialogs(TITLE_LOOKUP_LIMIT);
    const match = resolveTitle(dialogs, destination.title);
    if (match !== null) {
      return { target: match.id, resolved: { id: match.id, title: match.title } };
    }
    if (destination.usernameFallback) return { target: destination.title };
    throw noSuchChatError(destination.title);
  }

  const TOPIC_LOOKUP_LIMIT = 100;

  // Sending with a stale or wrong topic id does not error: Telegram quietly
  // files the message under General, in front of everyone in the group. So the
  // id is verified against the topic list first, the same way an ambiguous
  // chat title is refused rather than guessed at.
  async function verifyTopic(
    active: TelegramUserClient,
    target: string,
    topicId: number,
  ): Promise<{ id: number; title: string }> {
    let topics;
    try {
      topics = await active.listForumTopics(target, TOPIC_LOOKUP_LIMIT);
    } catch (err) {
      throw new Error(
        `Could not read the topic list for this chat, so the topic could not be verified: ${safeErrorMessage(err)}. If this chat is not a forum, omit topic_id.`,
      );
    }
    const match = topics.find((topic) => topic.id === topicId);
    if (match === undefined) {
      const shown = topics
        .slice(0, 8)
        .map((topic) => `${topic.title} (${topic.id})`)
        .join("; ");
      throw new Error(
        topics.length === 0
          ? `No topics in this chat — it is not a forum, or it has none. Omit topic_id to send to the chat itself.`
          : `No topic with id ${topicId} in this chat. Call list_forum_topics and use an id from it. Available: ${shown}`,
      );
    }
    if (match.closed === true) {
      throw new Error(
        `Topic ${JSON.stringify(match.title)} (${topicId}) is closed, so a message would not appear in it.`,
      );
    }
    return { id: match.id, title: match.title };
  }

  async function loginResult(payload: Record<string, unknown>) {
    const url = payload.login_url;
    return typeof url === "string" ? qrResult(url, payload) : jsonResult(payload);
  }

  function trackQr(token: Buffer): string {
    const url = qrUrl(token);
    issuedSecrets.push(url, token.toString("base64url"), token.toString("base64"));
    return url;
  }

  async function finishQr(
    active: TelegramUserClient,
    gen: number,
    password?: string,
  ): Promise<Record<string, unknown>> {
    const replaced = {
      ok: false,
      code: "cancelled",
      cancelled: true,
      message:
        "This QR attempt was cancelled or replaced. The session file was not changed. A previous code can no longer be completed.",
    };
    let token = await active.exportLoginToken();
    if (!attemptLive(gen)) return replaced;
    if (token.kind === "migrate") {
      issuedSecrets.push(token.token.toString("base64url"), token.token.toString("base64"));
      await active.switchDc(token.dcId);
      try {
        token = await active.importLoginToken(token.token);
      } catch (err) {
        if (!isExpiredLoginToken(err)) throw err;
        // The token this login started with has lapsed. That is a dead QR,
        // not a broken client: ask the server for a fresh one to show.
        token = await active.exportLoginToken();
      }
    }
    if (!attemptLive(gen)) return replaced;
    if (token.kind === "success") {
      clearPendingLogin();
      const saved = persist(active);
      return {
        ok: true,
        me: token.user,
        ...saved,
        warning: SESSION_SAVED_NOTE,
      };
    }
    if (password) {
      if (!attemptLive(gen)) return replaced;
      const me = await active.signInWithPassword(password);
      if (!attemptLive(gen)) return replaced;
      clearPendingLogin();
      const saved = persist(active);
      return { ok: true, me, ...saved, warning: SESSION_SAVED_NOTE };
    }
    if (token.kind === "token") {
      // Exporting again produced a *different* code. Saying only "not
      // completed yet" would send the user back to a QR that can no longer
      // be completed, so hand over the new one. The previous code is dead.
      const login_url = trackQr(token.token);
      return {
        ok: false,
        waiting: true,
        login_url,
        expires: token.expires,
        expires_in_seconds: expiresInSeconds(token.expires),
        note: `Not linked yet, and this is a NEW QR code — any code shown earlier can no longer be completed. ${QR_DELIVERY} Then call complete_qr_login again; each attempt hands back a fresh code, so repeat as needed. If 2FA is enabled, pass password. If the process running this server restarted since start_qr_login, that is why: a QR login cannot be resumed, and start_login with a phone number is the path that survives one.`,
      };
    }
    return {
      ok: false,
      waiting: true,
      note: "QR not completed yet. Scan in Telegram (Settings → Devices → Link Desktop Device), then call complete_qr_login again. If 2FA is enabled, pass password.",
    };
  }

  server.registerTool(
    "save_api_credentials",
    {
      title: "Save Telegram api_id and api_hash",
      description:
        "[User account] Store the api_id and api_hash the user obtained from https://my.telegram.org/apps, so they do not have to be set as environment variables. Written to a 0600 file next to the session. Telegram issues these per developer and rejects credentials that have been published, so this package cannot ship a shared pair — every user needs their own, once. Never echo api_hash back to the user.",
      inputSchema: z.object({
        api_id: z
          .union([z.string().min(1), z.number()])
          .describe("api_id from my.telegram.org/apps. A positive integer."),
        api_hash: z
          .string()
          .min(1)
          .describe("api_hash from the same page. Treat as a secret."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ api_id, api_hash }) => {
      const apiHash = String(api_hash ?? "");
      try {
        const apiId = Number(String(api_id).trim());
        if (!Number.isInteger(apiId) || apiId <= 0) {
          return errorResult(
            new Error(
              "api_id must be a positive integer, as shown on my.telegram.org/apps.",
            ),
            secrets(apiHash),
          );
        }
        const trimmedHash = apiHash.trim();
        if (!/^[a-f0-9]{32}$/i.test(trimmedHash)) {
          // A truncated or swapped paste otherwise fails much later, with an
          // error that points nowhere near the actual mistake.
          return errorResult(
            new Error(
              "api_hash does not look right: it is 32 hexadecimal characters on my.telegram.org/apps. Check that the whole value was copied, and that api_id and api_hash were not swapped.",
            ),
            secrets(apiHash, trimmedHash),
          );
        }

        const path = writeApiCredentials({ apiId, apiHash: trimmedHash });
        client = undefined;
        return jsonResult({
          ok: true,
          saved_to: path,
          api_id: apiId,
          note: "Stored with mode 0600. api_hash is deliberately not echoed back. Next step: start_login with the user's phone number.",
        });
      } catch (err) {
        return errorResult(err, secrets(apiHash));
      }
    },
  );

  server.registerTool(
    "auth_status",
    {
      title: "User-account auth status",
      description:
        "[User account] Check whether TELEGRAM_API_ID / TELEGRAM_API_HASH / session are configured and whether the MTProto session is authorized. Does not use TELEGRAM_BOT_TOKEN.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        try {
          getUserApiCredentials();
        } catch (err) {
          return jsonResult({
            configured: false,
            authorized: false,
            credentials_source: apiCredentialsSource(),
            session_source: sessionSource(),
            error: safeErrorMessage(err),
          });
        }
        const active = await getClient();
        const authorized = await active.isAuthorized();
        return jsonResult({
          configured: true,
          authorized,
          credentials_source: apiCredentialsSource(),
          session_source: sessionSource(),
          // Profile fields can still include phone and id. There is no host
          // redaction API to mask them; the session string is not included.
          me: authorized ? await active.getMe() : undefined,
          pending_phone_login: Boolean(pendingPhone),
        });
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  server.registerTool(
    "cancel_login",
    {
      title: "Cancel in-flight login",
      description:
        "[User account] Cancel an in-flight phone or QR login. Does not log the Telegram account out, does not delete an existing session file, and does not overwrite it. A QR code from the cancelled attempt can no longer be completed, including from a new process.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        generation += 1;
        loginCancelled = true;
        pendingPhone = undefined;
        qrUnsubscribe?.();
        qrUnsubscribe = undefined;
        qrScanned = undefined;
        const wake = cancelWait;
        cancelWait = undefined;
        wake?.();
        clearPendingLogin();
        markLoginCancelled();
        return jsonResult({
          ok: true,
          code: "cancelled",
          cancelled: true,
          message:
            "In-flight login cancelled. An existing session file was left unchanged. This does not log the account out of Telegram.",
        });
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  server.registerTool(
    "start_login",
    {
      title: "Start phone login",
      description:
        "[User account] Send a Telegram login code to the user's phone. Then call complete_login with the code (and 2FA password if needed).",
      inputSchema: z.object({
        phone: z
          .string()
          .min(6)
          .describe("Phone number in international format, e.g. +15551234567."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ phone }) => {
      const gen = beginAttempt();
      try {
        const active = await getClient();
        if (!attemptLive(gen)) {
          return cancelledResult(
            "Phone login was cancelled before it started. The session file was not changed.",
          );
        }
        if (await active.isAuthorized()) {
          return jsonResult({
            already_authorized: true,
            code: "already_authorized",
            me: await active.getMe(),
          });
        }
        const result = await active.sendCode(phone.trim());
        if (!attemptLive(gen)) {
          return cancelledResult(
            "Phone login was cancelled. The session file was not changed.",
          );
        }
        pendingPhone = {
          phone: phone.trim(),
          phoneCodeHash: result.phoneCodeHash,
          isCodeViaApp: result.isCodeViaApp,
        };
        rememberPendingLogin(active, "phone", pendingPhone);
        return jsonResult({
          ok: true,
          phone: pendingPhone.phone,
          is_code_via_app: result.isCodeViaApp,
          next: "Ask the user for the login code, then call complete_login. Do not echo api_hash, the code, or the session.",
        });
      } catch (err) {
        return errorResult(err, secrets(phone));
      }
    },
  );

  server.registerTool(
    "complete_login",
    {
      title: "Complete phone login",
      description:
        "[User account] Submit the login code (and optional 2FA cloud password) after start_login. On success the session is written to the session file and is not returned. Password and code are never echoed.",
      inputSchema: z.object({
        code: z.string().min(1).describe("Login code from Telegram or SMS."),
        password: z
          .string()
          .optional()
          .describe("2FA cloud password if the account has two-step verification."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ code, password }) => {
      const hidden = secrets(code, password);
      try {
        if (cancelledNow()) {
          pendingPhone = undefined;
          clearPendingLogin();
          return cancelledResult(
            "Login was cancelled. The session file was not changed.",
          );
        }
        const pending = loadPendingPhone();
        if (!pending) {
          return errorResult(
            new Error(
              "No pending phone login. Call start_login with the phone number first. If you did, the login code has expired — start over.",
            ),
            hidden,
          );
        }
        const active = await getClient();
        if (cancelledNow()) {
          return cancelledResult(
            "Login was cancelled. The session file was not changed.",
          );
        }
        let me;
        try {
          me = await active.signIn(
            pending.phone,
            pending.phoneCodeHash,
            code.trim(),
          );
        } catch (err) {
          if (isPasswordNeeded(err)) {
            if (!password) {
              return errorResult(
                new ToolFailure(
                  "session_password_needed",
                  "SESSION_PASSWORD_NEEDED. This account has two-step verification. Call complete_login again with password. The password is not stored and is not echoed.",
                ),
                hidden,
              );
            }
            me = await active.signInWithPassword(password);
          } else {
            throw err;
          }
        }
        if (cancelledNow()) {
          return cancelledResult(
            "Login was cancelled before the session was saved. The session file was not changed.",
          );
        }
        pendingPhone = undefined;
        clearPendingLogin();
        const saved = persist(active);
        return jsonResult({
          ok: true,
          me,
          ...saved,
          warning: SESSION_SAVED_NOTE,
        });
      } catch (err) {
        return errorResult(err, hidden);
      }
    },
  );

  server.registerTool(
    "start_qr_login",
    {
      title: "Start QR login",
      description:
        "[User account] Begin QR / Link Desktop Device login. The result includes a scannable image and login_url for the owner. Do not copy the token into logs. Then call complete_qr_login after they scan. A QR login cannot be resumed in a new process.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const gen = beginAttempt();
      try {
        const active = await getClient();
        if (!attemptLive(gen)) {
          return cancelledResult(
            "QR login was cancelled before a code was issued. The session file was not changed.",
          );
        }
        if (await active.isAuthorized()) {
          return jsonResult({
            already_authorized: true,
            code: "already_authorized",
            me: await active.getMe(),
          });
        }
        qrUnsubscribe?.();
        let resolve = () => {};
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        qrScanned = { promise, resolve };
        qrUnsubscribe = active.onLoginToken(() => qrScanned?.resolve());
        const token = await active.exportLoginToken();
        if (!attemptLive(gen)) {
          return cancelledResult(
            "QR login was cancelled or replaced. The previous code can no longer be completed. The session file was not changed.",
          );
        }
        if (token.kind === "success") {
          clearPendingLogin();
          const saved = persist(active);
          return jsonResult({
            ok: true,
            already_authorized: true,
            code: "already_authorized",
            me: token.user,
            ...saved,
            warning: SESSION_SAVED_NOTE,
          });
        }
        if (token.kind !== "token") {
          return errorResult(new Error("Could not export a QR login token."), secrets());
        }
        // Deliberately not written to the pending file. A new process cannot
        // redeem this code; Telegram only announces the scan on this connection.
        const login_url = trackQr(token.token);
        return await loginResult({
          ok: true,
          login_url,
          expires: token.expires,
          expires_in_seconds: expiresInSeconds(token.expires),
          how: `${QR_DELIVERY} Then call complete_qr_login. If it reports waiting, it returns a fresh code — show that one. The previous code is dead.`,
          warning:
            "This server process must stay alive from here until the scan completes. A QR login cannot be resumed by a later process: Telegram announces the scan on the connection that exported the code, and the authorization only exists once that same connection redeems it. On a host that starts a process per tool call, use start_login with a phone number — that one does survive a restart.",
        });
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  server.registerTool(
    "complete_qr_login",
    {
      title: "Complete QR login",
      description:
        "[User account] Finish QR login after the user scans. Pass password if 2FA is enabled. On success the session is written to the session file and is not returned. A new process cannot redeem a QR from an earlier process; a waiting result is a new code and the previous code is dead.",
      inputSchema: z.object({
        password: z
          .string()
          .optional()
          .describe("2FA cloud password if two-step verification is enabled."),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(120000)
          .optional()
          .describe("Optional time to wait for the scan event (default 15000)."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ password, wait_ms }) => {
      const hidden = secrets(password);
      const gen = generation;
      try {
        if (cancelledNow()) {
          return cancelledResult(
            "QR login was cancelled. The session file was not changed.",
          );
        }
        const active = await getClient();
        if (cancelledNow()) {
          return cancelledResult(
            "QR login was cancelled. The session file was not changed.",
          );
        }
        // The scan can land while this process does not exist: the phone
        // authorizes the auth key server-side, and the resumed session is
        // that key. There is no token left to redeem, and none is needed.
        // This does not redeem a QR token exported by a different process.
        if (await active.isAuthorized()) {
          if (!attemptLive(gen)) {
            return cancelledResult(
              "QR login was cancelled. The session file was not changed.",
            );
          }
          clearPendingLogin();
          const saved = persist(active);
          return jsonResult({
            ok: true,
            me: await active.getMe(),
            ...saved,
            warning: SESSION_SAVED_NOTE,
          });
        }
        if (qrScanned && attemptLive(gen)) {
          const wait = wait_ms ?? 15_000;
          await new Promise<void>((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = () => {
              if (settled) return;
              settled = true;
              if (timer !== undefined) clearTimeout(timer);
              resolve();
            };
            cancelWait = done;
            timer = setTimeout(done, wait);
            qrScanned?.promise.then(done, done);
          });
          cancelWait = undefined;
        }
        if (cancelledNow() || !attemptLive(gen)) {
          return cancelledResult(
            "QR login was cancelled. The session file was not changed.",
          );
        }
        try {
          const outcome = await finishQr(active, gen, password);
          if (outcome.code === "cancelled") return jsonResult(outcome);
          return await loginResult(outcome);
        } catch (err) {
          if (isPasswordNeeded(err)) {
            if (!password) {
              return errorResult(
                new ToolFailure(
                  "session_password_needed",
                  "SESSION_PASSWORD_NEEDED. Call complete_qr_login again with password. The password is not stored and is not echoed.",
                ),
                hidden,
              );
            }
            if (!attemptLive(gen)) {
              return cancelledResult(
                "QR login was cancelled before the session was saved. The session file was not changed.",
              );
            }
            const me = await active.signInWithPassword(password);
            clearPendingLogin();
            const saved = persist(active);
            return jsonResult({
              ok: true,
              me,
              ...saved,
              warning: SESSION_SAVED_NOTE,
            });
          }
          throw err;
        }
      } catch (err) {
        return errorResult(err, hidden);
      }
    },
  );

  server.registerTool(
    "get_me",
    {
      title: "Get logged-in user",
      description:
        "[User account] Return the authorized personal Telegram user (not a bot). Use to verify the MTProto session.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const active = await getClient();
        if (!(await active.isAuthorized())) {
          return errorResult(
            new ToolFailure(
              "not_authorized",
              "Not logged in. Set TELEGRAM_SESSION or run start_login / start_qr_login. See the telegram-user-setup skill.",
            ),
            secrets(),
          );
        }
        return jsonResult(await active.getMe());
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  server.registerTool(
    "list_dialogs",
    {
      title: "List dialogs",
      description:
        "[User account] List chats from the real Telegram dialog list (inbox), not Bot API getUpdates.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max dialogs to return (1–200). Default 50."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      try {
        const active = await getClient();
        const dialogs = await active.listDialogs(limit ?? 50);
        return jsonResult({ dialogs, count: dialogs.length });
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  server.registerTool(
    "search_dialogs",
    {
      title: "Search dialogs",
      description:
        "[User account] Search the dialog list by title, username, or id. Resolve chats here before send_message.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Case-insensitive substring to match."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max dialogs to scan (1–200). Default 100."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      try {
        const active = await getClient();
        const dialogs = filterDialogs(
          await active.listDialogs(limit ?? 100),
          query,
        );
        return jsonResult({ query, dialogs, count: dialogs.length });
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  server.registerTool(
    "list_forum_topics",
    {
      title: "List forum topics",
      description:
        "[User account] List the topics of a group that has topics turned on. Returns each topic's id and title; that id is what send_message and get_messages take as topic_id. list_dialogs marks such groups with isForum. Call this before sending into a topic — a wrong id is not an error, the message simply lands in General.",
      inputSchema: z.object({
        chat: z
          .string()
          .min(1)
          .describe("The forum group: dialog id, @username, or title."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max topics to return (1–100). Default 100."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, limit }) => {
      try {
        const active = await getClient();
        const { target, resolved } = await resolveDestination(active, chat);
        const topics = await active.listForumTopics(
          target,
          limit ?? TOPIC_LOOKUP_LIMIT,
        );
        return jsonResult({
          chat,
          topics,
          count: topics.length,
          ...(topics.length === 0
            ? {
                note: "No topics. Either this group does not have topics turned on, or it has none. Send to the chat itself without topic_id.",
              }
            : {}),
          ...(resolved === undefined ? {} : { resolved_chat: resolved }),
        });
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  server.registerTool(
    "get_messages",
    {
      title: "Get recent messages",
      description:
        "[User account] Fetch recent history for a chat. Prefer a dialog id from list_dialogs; a title is resolved against the dialog list first. @username and me also work.",
      inputSchema: z.object({
        chat: z
          .string()
          .min(1)
          .describe("Chat id, @username, or me (Saved Messages)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages (1–100). Default 20."),
        topic_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Read one forum topic instead of the whole chat. Get the id from list_forum_topics.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, limit, topic_id }) => {
      try {
        const active = await getClient();
        const { target, resolved } = await resolveDestination(active, chat);
        const messages = await active.getMessages(target, limit ?? 20, topic_id);
        return jsonResult({
          chat,
          messages,
          count: messages.length,
          ...(topic_id === undefined ? {} : { topic_id }),
          ...(resolved === undefined ? {} : { resolved_chat: resolved }),
        });
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send as the logged-in user",
      description:
        "[User account] Send a text message as the personal Telegram account (not a bot). Confirm destination and text with the user first. Prefer a dialog id from list_dialogs: a chat title has to be resolved against the dialog list first, which costs an extra round trip and fails when the title is ambiguous. A disclaimer footer is appended to every message unless TELEGRAM_DISCLAIMER is off, and it counts against Telegram's 4096-character limit.",
      inputSchema: z.object({
        chat: z
          .string()
          .min(1)
          .describe("Destination: me, @username, or a dialog id from list_dialogs."),
        text: z.string().min(1).max(4096).describe("Message text to send."),
        topic_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Send into a forum topic instead of the chat itself. Get the id from list_forum_topics; it is verified before sending, because a wrong one would land in General.",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ chat, text, topic_id }) => {
      try {
        const active = await getClient();
        if (!(await active.isAuthorized())) {
          return errorResult(
            new ToolFailure(
              "not_authorized",
              "Not logged in. Complete user-account login before sending.",
            ),
            secrets(),
          );
        }
        const { target, resolved } = await resolveDestination(active, chat);
        const topic =
          topic_id === undefined
            ? undefined
            : await verifyTopic(active, target, topic_id);
        const sentText = applyDisclaimer(text);
        const result = await active.sendMessage(target, sentText, topic_id);
        return jsonResult({
          ...result,
          identity: "user-account",
          disclaimer: disclaimerText(),
          ...(topic === undefined ? {} : { topic }),
          ...(resolved === undefined ? {} : { resolved_chat: resolved }),
        });
      } catch (err) {
        return errorResult(err, secrets());
      }
    },
  );

  return server;
}

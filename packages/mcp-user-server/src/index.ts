import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createTelegramUserMcpServer } from "./server.js";
import { redirectConsoleOffStdout } from "./stdio-guard.js";

redirectConsoleOffStdout();
serveStdio(() => createTelegramUserMcpServer());

// MCP stdio speaks JSON-RPC on stdout. Library logs that use console.log would
// be parsed as protocol frames, so those methods are forwarded to stderr.
// console.error is already stderr and is left alone.

const METHODS = ["log", "info", "debug", "warn"] as const;

export function redirectConsoleOffStdout(): void {
  for (const method of METHODS) {
    console[method] = (...args: unknown[]) => {
      const text = args
        .map((part) => {
          if (typeof part === "string") return part;
          try {
            return JSON.stringify(part);
          } catch {
            return String(part);
          }
        })
        .join(" ");
      process.stderr.write(`${text}\n`);
    };
  }
}

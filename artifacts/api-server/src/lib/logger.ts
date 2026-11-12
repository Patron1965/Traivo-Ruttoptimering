type LogContext = Record<string, unknown>;

function write(level: "info" | "warn" | "error", context: LogContext, message: string): void {
  const entry = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...context,
  });

  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.info(entry);
  }
}

export const logger = {
  info(context: LogContext, message: string): void {
    write("info", context, message);
  },
  warn(context: LogContext, message: string): void {
    write("warn", context, message);
  },
  error(context: LogContext, message: string): void {
    write("error", context, message);
  },
};
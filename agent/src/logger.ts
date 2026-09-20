import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "manzi-junior" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["*.token", "*.apiKey", "*.authorization", "headers.authorization"],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;

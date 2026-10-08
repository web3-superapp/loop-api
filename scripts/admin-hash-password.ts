import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hashAdminPassword } from "../src/features/admin/admin-auth.js";

/**
 * `pnpm admin:hash-password` (Decision 0102): turns the operator console
 * password into the argon2id PHC string ADMIN_PASSWORD_HASH expects.
 *
 * The password is read from standard input — typed without echo on a
 * terminal, or piped (`printf '%s' "$PW" | pnpm -s admin:hash-password`).
 * It is never accepted as an argument (shell history) and never printed.
 * The output line is ready to paste into an env file; it is single-quoted
 * because the PHC string contains `$`, which Docker Compose would otherwise
 * interpolate.
 */

interface InputStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  removeAllListeners(event: string): unknown;
  pause(): unknown;
  resume(): unknown;
}

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export function readPassword(
  input: InputStream,
  prompt: OutputWriter,
): Promise<string> {
  return new Promise((resolvePassword) => {
    let value = "";
    input.setEncoding("utf8");
    if (input.isTTY === true && input.setRawMode !== undefined) {
      prompt.write("Administrator password (input hidden): ");
      input.setRawMode(true);
      input.resume();
      input.on("data", (chunk: string) => {
        for (const character of chunk) {
          if (
            character === "\r" ||
            character === "\n" ||
            character === "\u0004"
          ) {
            input.setRawMode?.(false);
            input.removeAllListeners("data");
            input.pause();
            prompt.write("\n");
            resolvePassword(value);
            return;
          }
          if (character === "\u0003") {
            input.setRawMode?.(false);
            prompt.write("\n");
            process.exit(130);
          }
          if (character === "\u007f" || character === "\b") {
            value = value.slice(0, -1);
          } else {
            value += character;
          }
        }
      });
      return;
    }
    input.on("data", (chunk: string) => {
      value += chunk;
    });
    input.on("end", () => {
      resolvePassword(value.replace(/\r?\n$/u, ""));
    });
    input.resume();
  });
}

export async function runAdminHashPassword(options: {
  readonly input: InputStream;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
}): Promise<0 | 1> {
  const password = await readPassword(options.input, options.stderr);
  if (password.length < 12 || password.length > 256) {
    options.stderr.write(
      "Refused: the administrator password must be 12-256 characters\n",
    );
    return 1;
  }
  const hash = await hashAdminPassword(password);
  options.stdout.write(`ADMIN_PASSWORD_HASH='${hash}'\n`);
  return 0;
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runAdminHashPassword({
    input: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

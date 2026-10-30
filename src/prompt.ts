import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Hidden password input. For unattended runs the password can come from a
 * file named by B20MINER_PASSWORD_FILE (first line). It is never read from
 * a command-line flag, so it cannot land in shell history or `ps`.
 */
export async function readPassword(question: string): Promise<string> {
  const file = process.env.B20MINER_PASSWORD_FILE;
  if (file) return readFileSync(file, "utf8").split(/\r?\n/)[0] ?? "";
  if (!process.stdin.isTTY) throw new Error("No terminal for the password prompt. Set B20MINER_PASSWORD_FILE for unattended runs.");

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

export async function readLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

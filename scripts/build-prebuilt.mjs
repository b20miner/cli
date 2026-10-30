#!/usr/bin/env node
/**
 * Builds the native hasher for the platforms this machine can target and
 * places it in native/prebuilt/<platform>-<arch>/. On macOS, Apple clang
 * builds both arm64 and x86_64. Other platforms fall back at run time to a
 * one-time local build (cc/gcc/clang) or the built-in JS hasher.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const targets = process.platform === "darwin" ? [["darwin-arm64", "arm64"], ["darwin-x64", "x86_64"]] : [[`${process.platform}-${process.arch}`, null]];
for (const [dir, arch] of targets) {
  mkdirSync(new URL(`../native/prebuilt/${dir}/`, import.meta.url), { recursive: true });
  const out = new URL(`../native/prebuilt/${dir}/b20miner-hasher`, import.meta.url).pathname;
  const args = ["-O3", "-std=c11", ...(arch ? ["-arch", arch, "-mmacosx-version-min=11.0"] : []), "-o", out, new URL("../native/hasher.c", import.meta.url).pathname];
  execFileSync("cc", args, { stdio: "inherit" });
  console.log(`built native/prebuilt/${dir}/b20miner-hasher`);
}

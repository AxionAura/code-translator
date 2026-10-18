#!/usr/bin/env node
// M0 entry point: runs the CLI from TypeScript sources via Node's built-in type
// stripping plus a resolve hook that maps `.js` relative specifiers to their `.ts`
// sources (requires Node >= 22.18). Replaced by compiled dist output when the build
// step lands (docs/roadmap.md).
import { register } from "node:module";

register("./ctrans-loader.mjs", import.meta.url);

const { runCliCommand } = await import("../src/main.ts");

const result = await runCliCommand(process.argv.slice(2));
if (result.stdout.length > 0) process.stdout.write(result.stdout);
if (result.stderr.length > 0) process.stderr.write(result.stderr);
process.exitCode = result.code;

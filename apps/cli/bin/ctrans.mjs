#!/usr/bin/env node
// M0 entry point: runs the CLI from TypeScript sources via Node's built-in type
// stripping (requires Node >= 22.18). Replaced by the compiled dist entry when the
// build step lands in M4 (docs/roadmap.md).
import { runCli } from "../src/main.ts";

const result = runCli(process.argv.slice(2));
if (result.stdout.length > 0) process.stdout.write(result.stdout);
if (result.stderr.length > 0) process.stderr.write(result.stderr);
process.exitCode = result.code;

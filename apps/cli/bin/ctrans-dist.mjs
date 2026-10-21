#!/usr/bin/env node
// Compiled distribution entry (M11): runs the built CLI from apps/cli/dist. The
// package-manager bin points here; `bin/ctrans.mjs` remains the source-mode
// launcher used by development/tests.
import { runCliCommand } from "../dist/main.js";

const result = await runCliCommand(process.argv.slice(2));
if (result.stdout.length > 0) process.stdout.write(result.stdout);
if (result.stderr.length > 0) process.stderr.write(result.stderr);
process.exitCode = result.code;

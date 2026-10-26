// Stands in for the `claude` binary: ignores its flags and prints a canned stdout read from a file.
// Usage: bun fake-claude.ts <stdout-file> [exit-code] -- <claude flags ignored>
import { readFileSync } from "node:fs";

const [file, code] = process.argv.slice(2);
await Bun.stdin.text();
process.stdout.write(readFileSync(file!, "utf8"));
process.exit(Number(code) || 0);

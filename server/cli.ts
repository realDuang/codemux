import { runHostCli } from "./cli-commands";

process.exitCode = await runHostCli(process.argv.slice(2));

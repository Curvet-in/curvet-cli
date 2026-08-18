import { createRequire } from "node:module";
import { Command } from "commander";
import { formatError } from "./output.js";
import { authCommand } from "./commands/auth.js";
import { modelsCommand } from "./commands/models.js";
import { chatCommand } from "./commands/chat.js";
import { balanceCommand } from "./commands/balance.js";
import { doctorCommand } from "./commands/doctor.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command()
  .name("curvet")
  .description("Curvet in your terminal — chat, models, balance, and diagnostics.")
  .version(pkg.version)
  .option("--profile <name>", "config profile to use (default: the `auth use` default)");

program.addCommand(authCommand());
program.addCommand(modelsCommand());
program.addCommand(chatCommand());
program.addCommand(balanceCommand());
program.addCommand(doctorCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});

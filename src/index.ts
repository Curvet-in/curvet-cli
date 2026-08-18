import { createRequire } from "node:module";
import { Command } from "commander";
import { formatError } from "./output.js";
import { authCommand } from "./commands/auth.js";
import { modelsCommand } from "./commands/models.js";
import { chatCommand } from "./commands/chat.js";
import { imageCommand } from "./commands/image.js";
import { mediaCommands } from "./commands/media.js";
import { jobsCommand } from "./commands/jobs.js";
import { workflowsCommand } from "./commands/workflows.js";
import { analyticsCommand } from "./commands/analytics.js";
import { balanceCommand } from "./commands/balance.js";
import { configCommand } from "./commands/config.js";
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
program.addCommand(imageCommand());
for (const cmd of mediaCommands()) program.addCommand(cmd);
program.addCommand(jobsCommand());
program.addCommand(workflowsCommand());
program.addCommand(analyticsCommand());
program.addCommand(balanceCommand());
program.addCommand(configCommand());
program.addCommand(doctorCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});

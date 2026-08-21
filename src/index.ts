import { createRequire } from "node:module";
import { Command } from "commander";
import { formatError } from "./output.js";
import { authCommand } from "./commands/auth.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { appsCommand, keysCommand } from "./commands/apps.js";
import { modelsCommand } from "./commands/models.js";
import { chatCommand } from "./commands/chat.js";
import { agentCommand } from "./commands/agent.js";
import { commitCommand } from "./commands/commit.js";
import { imageCommand } from "./commands/image.js";
import { mediaCommands } from "./commands/media.js";
import { sttCommand } from "./commands/stt.js";
import { jobsCommand } from "./commands/jobs.js";
import { workflowsCommand } from "./commands/workflows.js";
import { analyticsCommand } from "./commands/analytics.js";
import { entCommand } from "./commands/ent.js";
import { balanceCommand } from "./commands/balance.js";
import { configCommand } from "./commands/config.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { proxyCommand } from "./commands/proxy.js";
import { mcpCommand } from "./commands/mcp.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command()
  .name("curvet")
  .description("Curvet in your terminal — chat, models, balance, and diagnostics.")
  .version(pkg.version)
  .option("--profile <name>", "config profile to use (default: the `auth use` default)");

program.addCommand(loginCommand());
program.addCommand(logoutCommand());
program.addCommand(authCommand());
program.addCommand(appsCommand());
program.addCommand(keysCommand());
program.addCommand(modelsCommand());
program.addCommand(chatCommand());
program.addCommand(agentCommand());
program.addCommand(commitCommand());
program.addCommand(imageCommand());
for (const cmd of mediaCommands()) program.addCommand(cmd);
program.addCommand(sttCommand());
program.addCommand(jobsCommand());
program.addCommand(workflowsCommand());
program.addCommand(analyticsCommand());
program.addCommand(entCommand());
program.addCommand(balanceCommand());
program.addCommand(configCommand());
program.addCommand(doctorCommand());
program.addCommand(initCommand());
program.addCommand(proxyCommand());
program.addCommand(mcpCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});

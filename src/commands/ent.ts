import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import type { Curvet, EnterpriseMember } from "@curvet/sdk";
import { resolveProfile, type ResolvedProfile } from "../config.js";
import { makeClient } from "../client.js";
import { printJson, ok, table, trimNumber, warn } from "../output.js";
import {
  csvCell,
  describePoolAccess,
  findMember,
  parseInviteCsv,
  parsePoolAccess,
  parseRole,
  type InviteRow,
} from "../enterprise.js";

/** Every `ent` command needs the org-scoped key, not the playground one. */
function requireEnterpriseKey(profile: ResolvedProfile): void {
  if (!profile.enterpriseKey) {
    throw new Error(
      "This command needs an enterprise key (org scope). Run `curvet auth login` " +
        "and paste one, or set CURVET_ENTERPRISE_KEY.",
    );
  }
}

async function enterpriseClient(cmd: Command): Promise<{ client: Curvet; profile: ResolvedProfile }> {
  const profile = await resolveProfile(cmd.optsWithGlobals().profile);
  requireEnterpriseKey(profile);
  return { client: makeClient(profile), profile };
}

/** Resolve an email (or UID) against the member list, fetched once per command. */
async function resolve(client: Curvet, needle: string): Promise<EnterpriseMember> {
  return findMember(await client.enterprise.members.list(), needle);
}

const SPEND_ORDER = pc.dim(
  "Company spend draws in order: the member's own allotment, then the org pool, then their personal credits.",
);

function memberRows(members: EnterpriseMember[]): string[][] {
  return members.map((m) => [
    m.email,
    m.role,
    trimNumber(m.allotted),
    trimNumber(m.used),
    m.cap === 0 ? "uncapped" : trimNumber(m.cap),
    m.remaining == null ? "—" : trimNumber(m.remaining),
    describePoolAccess(m),
    m.isRestricted ? "restricted" : "",
  ]);
}

const MEMBER_HEADERS = [
  "EMAIL",
  "ROLE",
  "ALLOTTED",
  "USED",
  "CAP",
  "REMAINING",
  "POOL",
  "STATUS",
];

function overviewCommand(): Command {
  return new Command("overview")
    .description("Org pool balance, seats, and per-member usage")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const { client } = await enterpriseClient(cmd);
      const data = await client.enterprise.overview();

      if (opts.json) {
        printJson(data);
        return;
      }

      const org = data.organization as { name?: string; subscriptionTier?: string };
      console.log(pc.bold(org.name ?? "organization") + pc.dim(` · ${data.month}`));
      console.log(
        table(
          ["METRIC", "VALUE"],
          [
            ["pool balance", trimNumber(data.pool.balance)],
            ["allocated to members", trimNumber(data.pool.allocatedToMembers)],
            ["used this month", trimNumber(data.pool.totalUsedThisMonth)],
            ["members", String(data.memberCount)],
            ["seats remaining", data.seatsRemaining == null ? "unlimited" : String(data.seatsRemaining)],
            ...(org.subscriptionTier ? [["tier", org.subscriptionTier]] : []),
          ],
        ),
      );

      if (data.members.length > 0) {
        console.log(`\n${pc.bold("MEMBERS")}`);
        console.log(table(MEMBER_HEADERS, memberRows(data.members)));
      }
      console.log(`\n${SPEND_ORDER}`);
    });
}

// ── invites ──────────────────────────────────────────────────────────────────

function inviteFlags(cmd: Command): Command {
  return cmd
    .option("--email <address>", "bind the invite to one address")
    .option("--role <role>", "admin or member (default: member)")
    .option("--credits <n>", "enterprise credits to reserve, funded from the pool", Number)
    .option("--limit <n>", "monthly spend cap set on join (0 = uncapped)", Number)
    .option("--expires-in-days <n>", "how long the token stays valid", Number)
    .option("--label <text>", "a note for your own reference");
}

function inviteCreateCommand(): Command {
  const cmd = new Command("create").description("Create a single-use invite link");
  inviteFlags(cmd)
    .option("--json", "machine-readable output")
    .action(async (opts, self) => {
      const { client } = await enterpriseClient(self);
      const result = await client.enterprise.invites.create({
        email: opts.email,
        role: opts.role ? parseRole(opts.role) : undefined,
        allottedCredits: opts.credits,
        creditLimit: opts.limit,
        expiresInDays: opts.expiresInDays,
        label: opts.label,
      });

      if (opts.json) {
        printJson(result);
        return;
      }
      // The URL is the deliverable, so it goes to stdout alone and pipes cleanly.
      console.log(result.url);
      process.stderr.write(
        pc.dim(
          `— ${result.invite.boundEmail ?? "unbound"} · ${result.invite.role} · ` +
            `${trimNumber(result.invite.allottedCredits)} credits · ` +
            `expires ${result.invite.expiresAt ?? "never"}\n`,
        ) +
          warn("This link is shown once — it is stored only as a hash. Save it now.") +
          "\n",
      );
    });
  return cmd;
}

/**
 * Bulk invites, written to disk as they are created.
 *
 * The token is returned exactly once and only a SHA-256 hash is kept, so a run
 * that creates forty links and then dies has destroyed forty invites. Each row
 * is therefore appended and flushed before the next request goes out, and a
 * failure is recorded in the file rather than aborting the rest.
 */
function inviteBulkCommand(): Command {
  return new Command("bulk")
    .description("Create invites for every row of a CSV, saving the links as it goes")
    .argument("<file>", "CSV: email[,credits,role,limit,label], header row optional")
    .option("-o, --out <file>", "where to write the links (default: <file>-invites.csv)")
    .option("--force", "overwrite the output file if it already exists")
    .option("--dry-run", "parse and print the rows without creating anything")
    .action(async (file: string, opts, cmd) => {
      const rows = parseInviteCsv(await fs.readFile(file, "utf8"));

      if (opts.dryRun) {
        console.log(
          table(
            ["EMAIL", "ROLE", "CREDITS", "LIMIT", "LABEL"],
            rows.map((r) => [
              r.email,
              r.role ?? "member",
              r.allottedCredits == null ? "" : String(r.allottedCredits),
              r.creditLimit == null ? "" : String(r.creditLimit),
              r.label ?? "",
            ]),
          ),
        );
        console.log(pc.dim(`\n${rows.length} invites would be created. Re-run without --dry-run.`));
        return;
      }

      const { client } = await enterpriseClient(cmd);
      const out = opts.out ?? `${file.replace(/\.csv$/i, "")}-invites.csv`;
      if (existsSync(out) && !opts.force) {
        throw new Error(`${out} already exists. Pass --out elsewhere, or --force to overwrite.`);
      }

      const stream = createWriteStream(out, { flags: "w", mode: 0o600 });
      const write = (cells: unknown[]) =>
        new Promise<void>((resolve, reject) => {
          stream.write(cells.map(csvCell).join(",") + "\n", (err) =>
            err ? reject(err) : resolve(),
          );
        });
      await write(["email", "role", "credits", "limit", "label", "url", "inviteId", "error"]);

      let created = 0;
      const failures: Array<{ row: InviteRow; message: string }> = [];
      for (const row of rows) {
        try {
          const result = await client.enterprise.invites.create({
            email: row.email,
            role: row.role,
            allottedCredits: row.allottedCredits,
            creditLimit: row.creditLimit,
            label: row.label,
          });
          // Written before the next request: a crash costs at most the one
          // invite in flight, not every token created so far.
          await write([
            row.email,
            result.invite.role,
            result.invite.allottedCredits,
            result.invite.creditLimit,
            result.invite.label,
            result.url,
            result.invite._id,
            "",
          ]);
          created++;
          process.stderr.write(pc.dim(`  ${row.email} ✓\n`));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await write([row.email, row.role, row.allottedCredits, row.creditLimit, row.label, "", "", message]);
          failures.push({ row, message });
          process.stderr.write(warn(`  ${row.email} — ${message}\n`));
        }
      }
      await new Promise<void>((resolve) => stream.end(resolve));

      console.log(ok(`${created}/${rows.length} invites created — links saved to ${out}`));
      if (failures.length > 0) {
        console.log(
          warn(`${failures.length} failed; their rows in ${out} carry the reason in the error column.`),
        );
        process.exitCode = 1;
      }
    });
}

function inviteListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("Invites for the organization")
    .option("--status <status>", "pending, claimed, expired, or revoked")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const { client } = await enterpriseClient(cmd);
      const invites = await client.enterprise.invites.list({ status: opts.status });

      if (opts.json) {
        printJson(invites);
        return;
      }
      if (invites.length === 0) {
        console.log(warn(opts.status ? `No ${opts.status} invites.` : "No invites yet."));
        return;
      }
      console.log(
        table(
          ["ID", "EMAIL", "ROLE", "CREDITS", "STATUS", "EXPIRES", "LABEL"],
          invites.map((i) => [
            i._id,
            i.boundEmail ?? "—",
            i.role,
            trimNumber(i.allottedCredits),
            i.status,
            i.expiresAt ? i.expiresAt.slice(0, 10) : "never",
            i.label ?? "",
          ]),
        ),
      );
    });
}

function inviteRevokeCommand(): Command {
  return new Command("revoke")
    .description("Revoke a pending invite so its link stops working")
    .argument("<inviteId>", "id from `curvet ent invite list`")
    .action(async (inviteId: string, _opts, cmd) => {
      const { client } = await enterpriseClient(cmd);
      await client.enterprise.invites.revoke(inviteId);
      console.log(ok(`revoked ${inviteId}`));
    });
}

function inviteCommand(): Command {
  const invite = new Command("invite").alias("invites").description("Create and manage invite links");
  invite.addCommand(inviteCreateCommand());
  invite.addCommand(inviteBulkCommand());
  invite.addCommand(inviteListCommand());
  invite.addCommand(inviteRevokeCommand());
  return invite;
}

// ── members ──────────────────────────────────────────────────────────────────

function membersListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("Members with their allotment, usage, cap, and pool access")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const { client } = await enterpriseClient(cmd);
      const members = await client.enterprise.members.list();

      if (opts.json) {
        printJson(members);
        return;
      }
      if (members.length === 0) {
        console.log(warn("No members yet — invite some with `curvet ent invite create`."));
        return;
      }
      console.log(table(MEMBER_HEADERS, memberRows(members)));
      console.log(`\n${SPEND_ORDER}`);
    });
}

function setCreditsCommand(): Command {
  return new Command("set-credits")
    .description("Assign credits from the pool to a member, or reclaim them with a negative amount")
    .argument("<member>", "email (or Firebase UID)")
    .argument("<amount>", "credits to move; negative reclaims back to the pool")
    .option("--description <text>", "note recorded on the transaction")
    // Commander reads a leading `-` as an option, so a bare `-100` dies as
    // "unknown option" before the action ever runs. Allowing unknown options
    // lets the negative amount through as the argument it is; the guard below
    // then rejects anything genuinely unexpected, so a mistyped flag on a
    // command that moves credits still fails loudly.
    .allowUnknownOption()
    .action(async (needle: string, rawAmount: string, opts, cmd) => {
      const extra = cmd.args.slice(2);
      if (extra.length > 0) {
        throw new Error(`Unexpected argument "${extra[0]}" — see \`curvet ent members set-credits --help\`.`);
      }
      const amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount === 0) {
        throw new Error(`Amount must be a non-zero number, not "${rawAmount}".`);
      }
      const { client } = await enterpriseClient(cmd);
      const member = await resolve(client, needle);
      await client.enterprise.members.assignCredits(member.firebaseUid, amount, {
        description: opts.description,
      });
      const verb = amount > 0 ? "assigned to" : "reclaimed from";
      console.log(ok(`${trimNumber(Math.abs(amount))} credits ${verb} ${member.email}`));
    });
}

function setLimitCommand(): Command {
  return new Command("set-limit")
    .description("Set a member's monthly cap on company spend (0 = uncapped)")
    .argument("<member>", "email (or Firebase UID)")
    .argument("<credits>", "monthly cap in credits; 0 removes it")
    .action(async (needle: string, rawLimit: string, _opts, cmd) => {
      const limit = Number(rawLimit);
      if (!Number.isFinite(limit) || limit < 0) {
        throw new Error(`The cap must be zero or a positive number, not "${rawLimit}".`);
      }
      const { client } = await enterpriseClient(cmd);
      const member = await resolve(client, needle);
      await client.enterprise.members.setLimit(member.firebaseUid, limit);
      console.log(
        ok(limit === 0 ? `${member.email} is now uncapped` : `${member.email} capped at ${trimNumber(limit)} credits/month`),
      );
    });
}

function poolAccessCommand(): Command {
  return new Command("pool-access")
    .description("Let a member spend the org pool directly, or stop them")
    .argument("<member>", "email (or Firebase UID)")
    .argument("<setting>", "on, off, or inherit (inherit = admins on, members off)")
    .action(async (needle: string, setting: string, _opts, cmd) => {
      const drawsFromPool = parsePoolAccess(setting);
      const { client } = await enterpriseClient(cmd);
      const member = await resolve(client, needle);
      const result = await client.enterprise.members.setPoolAccess(
        member.firebaseUid,
        drawsFromPool,
      );
      const state = result.effective ? "draws from the org pool" : "does not draw from the org pool";
      const how = result.drawsFromPool == null ? ` (inherited from ${member.role})` : "";
      console.log(ok(`${member.email} ${state}${how}`));
      if (result.effective && member.cap === 0) {
        console.log(
          warn(`${member.email} has no monthly cap — set one with \`curvet ent members set-limit ${member.email} <credits>\`.`),
        );
      }
    });
}

function setRoleCommand(): Command {
  return new Command("set-role")
    .description("Change a member's role")
    .argument("<member>", "email (or Firebase UID)")
    .argument("<role>", "admin or member")
    .action(async (needle: string, rawRole: string, _opts, cmd) => {
      const role = parseRole(rawRole);
      const { client } = await enterpriseClient(cmd);
      const member = await resolve(client, needle);
      await client.enterprise.members.setRole(member.firebaseUid, role);
      console.log(ok(`${member.email} is now ${role}`));
      if (member.drawsFromPool == null) {
        console.log(
          pc.dim(`  Pool access is inherited from the role, so it is now ${role === "admin" ? "on" : "off"}.`),
        );
      }
    });
}

function removeMemberCommand(): Command {
  return new Command("remove")
    .alias("rm")
    .description("Remove a member; their enterprise credits return to the pool")
    .argument("<member>", "email (or Firebase UID)")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (needle: string, opts, cmd) => {
      const { client } = await enterpriseClient(cmd);
      const member = await resolve(client, needle);

      if (!opts.yes) {
        throw new Error(
          `This removes ${member.email} (${member.role}) from the organization and returns ` +
            `${trimNumber(member.allotted)} credits to the pool. Re-run with --yes to confirm.`,
        );
      }
      await client.enterprise.members.remove(member.firebaseUid);
      console.log(ok(`removed ${member.email}; ${trimNumber(member.allotted)} credits returned to the pool`));
    });
}

function membersCommand(): Command {
  const members = new Command("members").alias("member").description("Inspect and manage members");
  members.addCommand(membersListCommand());
  members.addCommand(setCreditsCommand());
  members.addCommand(setLimitCommand());
  members.addCommand(poolAccessCommand());
  members.addCommand(setRoleCommand());
  members.addCommand(removeMemberCommand());
  return members;
}

export function entCommand(): Command {
  const ent = new Command("ent")
    .alias("enterprise")
    .description("Enterprise admin — members, invites, credits (needs an enterprise key)");
  ent.addCommand(overviewCommand());
  ent.addCommand(inviteCommand());
  ent.addCommand(membersCommand());
  return ent;
}

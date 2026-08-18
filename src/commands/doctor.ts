import { Command } from "commander";
import pc from "picocolors";
import { Curvet, DEFAULT_BASE_URL, AuthError } from "@curvet/sdk";
import { resolveProfile, configPath, loadConfig } from "../config.js";
import { v1Root } from "../client.js";
import { maskKey, ok, warn, fail } from "../output.js";

type Level = "ok" | "warn" | "fail";
interface CheckResult {
  level: Level;
  message: string;
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Diagnose config, keys, connectivity, and rate-limit headroom")
    .action(async (_opts, cmd) => {
      const results: CheckResult[] = [];
      const add = (level: Level, message: string) => results.push({ level, message });

      // 1. Config file
      try {
        const config = await loadConfig();
        const count = Object.keys(config.profiles).length;
        add("ok", `config readable at ${configPath()} (${count} profile${count === 1 ? "" : "s"})`);
      } catch (err) {
        add("fail", `config unreadable: ${(err as Error).message}`);
      }

      const profile = await resolveProfile(cmd.optsWithGlobals().profile).catch(() => null);
      if (!profile) {
        add("fail", "could not resolve a profile");
        return finish(results);
      }
      add("ok", `active profile: ${profile.name}`);

      // 2. Base URL
      const base = profile.baseURL ?? DEFAULT_BASE_URL;
      if (profile.baseURL && profile.baseURL !== DEFAULT_BASE_URL) {
        add(
          "warn",
          `base URL overridden to ${profile.baseURL} (${profile.sources.baseURL ?? "profile"})`,
        );
      } else {
        add("ok", `base URL: ${base}`);
      }

      // 3. Key presence + format
      if (!profile.appKey && !profile.enterpriseKey) {
        add("fail", "no credentials — run `curvet auth login` or set CURVET_APP_KEY");
      }
      if (profile.appKey) {
        const src = profile.sources.appKey === "env" ? "env CURVET_APP_KEY" : "profile";
        if (/^(app_|cvt_app_)/.test(profile.appKey)) {
          add("ok", `app key ${maskKey(profile.appKey)} (${src})`);
        } else {
          add("warn", `app key ${maskKey(profile.appKey)} has an unexpected prefix (${src})`);
        }
      }
      if (profile.enterpriseKey) {
        const src =
          profile.sources.enterpriseKey === "env" ? "env CURVET_ENTERPRISE_KEY" : "profile";
        if (profile.enterpriseKey.startsWith("cvent_ent_")) {
          add("ok", `enterprise key ${maskKey(profile.enterpriseKey)} (${src})`);
        } else {
          add("warn", `enterprise key has an unexpected prefix — expected cvent_ent_… (${src})`);
        }
      }

      // 4. Keyless reachability via the public catalogue
      try {
        const res = await fetch(`${v1Root(profile.baseURL)}/public/models`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) add("ok", `API reachable (public catalogue HTTP ${res.status})`);
        else add("warn", `API responded HTTP ${res.status} on the public catalogue`);
      } catch (err) {
        add("fail", `cannot reach ${v1Root(profile.baseURL)}: ${(err as Error).message}`);
      }

      // 5. App-key scope: models + rate limits + balance
      if (profile.appKey) {
        try {
          const client = new Curvet({ appKey: profile.appKey, baseURL: profile.baseURL });
          const models = await client.models.list();
          const limits = await client.models.rateLimits();
          add(
            "ok",
            `app key works — ${models.length} models` +
              (limits ? `, ${limits.requestsPerHour} req/h, $${limits.costCapPerDay}/day cap` : ""),
          );
          const balance = await client.balance.get();
          const level = balance.totalAvailableUSD > 0 ? "ok" : "warn";
          add(level, `balance: $${balance.totalAvailableUSD} available`);
        } catch (err) {
          if (err instanceof AuthError) {
            add("fail", "app key rejected (401) — rotate it in the developer console");
          } else {
            add("fail", `app-key check failed: ${(err as Error).message}`);
          }
        }
      }

      // 6. Enterprise scope
      if (profile.enterpriseKey) {
        try {
          const client = new Curvet({
            enterpriseKey: profile.enterpriseKey,
            baseURL: profile.baseURL,
          });
          const overview = await client.enterprise.overview();
          const seats =
            overview.seatsRemaining == null ? "unlimited seats" : `${overview.seatsRemaining} seats left`;
          add(
            "ok",
            `enterprise key works — ${overview.memberCount} members, pool ${overview.pool.balance} credits, ${seats}`,
          );
        } catch (err) {
          if (err instanceof AuthError) {
            add("fail", "enterprise key rejected (401) — it may be revoked or expired");
          } else {
            add("fail", `enterprise check failed: ${(err as Error).message}`);
          }
        }
      }

      finish(results);
    });
}

function finish(results: CheckResult[]): void {
  for (const r of results) {
    if (r.level === "ok") console.log(ok(r.message));
    else if (r.level === "warn") console.log(warn(r.message));
    else console.log(fail(r.message));
  }
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log();
  if (fails > 0) {
    console.log(fail(pc.bold(`${fails} problem${fails === 1 ? "" : "s"} found`)));
    process.exitCode = 1;
  } else if (warns > 0) {
    console.log(warn(pc.bold(`healthy, with ${warns} warning${warns === 1 ? "" : "s"}`)));
  } else {
    console.log(ok(pc.bold("everything looks good")));
  }
}

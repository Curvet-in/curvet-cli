import type { ResolvedProfile } from "../config.js";

/**
 * What this server can actually do, decided once at startup.
 *
 * The old server called `requireAppKey` and exited, which is why the entire
 * agency surface was unreachable: a profile holding only a `cliToken` — the
 * credential agency needs — could not start it at all. Two credentials name
 * different things and neither is a superset of the other, so the question is
 * never "may this run" but "which half of it may run".
 *
 * Nothing here asks the network. A credential that exists can still be revoked,
 * expired or missing a scope; that surfaces as a tool failure with the server's
 * own words, which is more honest than a startup probe that goes stale the
 * moment it succeeds.
 */
export interface Capabilities {
  /** Playground: chat, models, media, jobs, workflows, balance, analytics. */
  playground: boolean;
  /** Agency runs. Needs a cliToken carrying the `agency:run` scope. */
  agent: boolean;
  /**
   * Whether this process shares a filesystem with the person using it.
   *
   * True over stdio, false when the same tools are served over HTTP. It decides
   * whether a tool may take a path, and it is declared to the model rather than
   * discovered by failing.
   */
  localFiles: boolean;
}

export interface CapabilityReport extends Capabilities {
  /** Why something is off, in the user's terms. Empty when everything is on. */
  missing: string[];
}

export function capabilitiesFor(
  profile: Pick<ResolvedProfile, "appKey" | "enterpriseKey" | "cliToken">,
  opts: { localFiles: boolean },
): CapabilityReport {
  const playground = Boolean(profile.appKey || profile.enterpriseKey);
  const agent = Boolean(profile.cliToken);
  const missing: string[] = [];

  if (!playground) {
    missing.push(
      "Chat, models, media and workflows need an app key. Run `curvet auth login`, " +
        "or set CURVET_APP_KEY.",
    );
  }
  if (!agent) {
    missing.push(
      "The agent needs you to be signed in with the agency:run scope. " +
        "Run `curvet login --scope agency:run`.",
    );
  }

  return { playground, agent, localFiles: opts.localFiles, missing };
}

/**
 * The one-paragraph description the host shows next to the server.
 *
 * It states what is OFF as plainly as what is on. A server that silently offers
 * three tools instead of eleven looks broken; one that says which credential is
 * absent gets fixed in a minute.
 */
export function instructionsFor(caps: CapabilityReport): string {
  const lines: string[] = [
    "Curvet — models, media generation, workflows and the Curvet agent.",
  ];

  if (caps.agent) {
    lines.push(
      caps.localFiles
        ? "run_agent can read files on this machine when you name them; it cannot read secrets " +
          "(.env, keys, credentials) or anything outside the project."
        : "This server has no filesystem: run_agent takes file CONTENT, never a path.",
    );
  }
  if (caps.missing.length > 0) {
    lines.push(`Some tools are unavailable here. ${caps.missing.join(" ")}`);
  }
  return lines.join(" ");
}

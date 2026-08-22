import { describe, expect, it, afterEach } from "vitest";
import { chooseScopes, scopeHelp, DEFAULT_SCOPES, OPTIONAL_SCOPES, ALL_SCOPES } from "../src/commands/login.js";

/**
 * Which scopes a login asks for.
 *
 * The problem this solves is discoverability, not policy. `agency:run` is kept
 * out of the default on purpose — it is the only grant that spends money by
 * itself — but before this existed the only way to FIND it was to run an agent,
 * be refused, and read the error. Keeping a scope out of the default is not a
 * reason to keep it out of sight.
 */

const realTTY = process.stdin.isTTY;
afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: realTTY, configurable: true });
});
function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

describe("chooseScopes", () => {
  it("asks nobody when scopes were named explicitly", async () => {
    setTTY(true); // would prompt, must not
    const got = await chooseScopes(["agency:run"], false);
    expect(got).toEqual([...DEFAULT_SCOPES, "agency:run"]);
  });

  it("always includes the defaults alongside an explicit scope", async () => {
    // Asking for agent access should not cost you the ability to manage apps.
    setTTY(true);
    const got = await chooseScopes(["enterprise:admin"], false);
    for (const s of DEFAULT_SCOPES) expect(got).toContain(s);
  });

  it("--all takes everything without asking", async () => {
    setTTY(true);
    expect(await chooseScopes([], true)).toEqual(ALL_SCOPES);
  });

  it("does not prompt without a terminal, and does not widen the grant either", async () => {
    // A scripted login must not block on a question — and silence is not consent
    // to a broader token than was asked for.
    setTTY(false);
    expect(await chooseScopes([], false)).toEqual(DEFAULT_SCOPES);
  });

  it("de-duplicates a scope named twice", async () => {
    setTTY(false);
    const got = await chooseScopes(["apps:read", "apps:read"], false);
    expect(got.filter((s) => s === "apps:read")).toHaveLength(1);
  });
});

describe("the scope list itself", () => {
  it("keeps the two spending/credential scopes out of the default", async () => {
    expect(DEFAULT_SCOPES).not.toContain("agency:run");
    expect(DEFAULT_SCOPES).not.toContain("enterprise:admin");
  });

  it("offers exactly the scopes that are not default", () => {
    // Otherwise a scope exists that no interactive login can ever reach.
    const optional = OPTIONAL_SCOPES.map((o) => o.scope);
    expect([...DEFAULT_SCOPES, ...optional].sort()).toEqual([...ALL_SCOPES].sort());
    expect(optional).toContain("agency:run");
  });

  it("names every scope in --help, with what it is for", () => {
    const help = scopeHelp();
    for (const s of ALL_SCOPES) expect(help, s).toContain(s);
    // The one people are actually looking for says why they want it.
    expect(help).toMatch(/curvet agent/);
  });

  it("says how to get an optional scope, in a runnable form", () => {
    expect(scopeHelp()).toMatch(/curvet login --scope agency:run/);
  });
});

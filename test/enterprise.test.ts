import { describe, expect, it } from "vitest";
import type { EnterpriseMember } from "@curvet/sdk";
import {
  csvCell,
  describePoolAccess,
  findMember,
  parseInviteCsv,
  parsePoolAccess,
  parseRole,
  splitCsvLine,
} from "../src/enterprise.js";

function member(partial: Partial<EnterpriseMember> & { email: string }): EnterpriseMember {
  return {
    firebaseUid: partial.email.split("@")[0].padEnd(28, "x"),
    role: "member",
    allotted: 0,
    used: 0,
    remaining: null,
    cap: 0,
    personalCredits: 0,
    drawsFromPool: null,
    drawsFromPoolEffective: false,
    isRestricted: false,
    ...partial,
  } as EnterpriseMember;
}

const AVA = member({ email: "ava@acme.test", role: "admin", drawsFromPoolEffective: true });
const BEN = member({ email: "ben@acme.test", allotted: 500 });
const MEMBERS = [AVA, BEN];

describe("findMember", () => {
  it("resolves an email to the member", () => {
    expect(findMember(MEMBERS, "ben@acme.test").firebaseUid).toBe(BEN.firebaseUid);
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(findMember(MEMBERS, "  Ava@ACME.test ").email).toBe("ava@acme.test");
  });

  // --json output contains UIDs, so one command's output can feed the next.
  it("accepts a raw Firebase UID", () => {
    expect(findMember(MEMBERS, BEN.firebaseUid).email).toBe("ben@acme.test");
  });

  it("refuses to guess when one address matches two members", () => {
    const twin = member({ email: "ben@acme.test", firebaseUid: "other-uid" });
    expect(() => findMember([...MEMBERS, twin], "ben@acme.test")).toThrow(/matches 2 members/);
  });

  it("suggests near matches for an unknown address", () => {
    expect(() => findMember(MEMBERS, "ben@other.test")).toThrow(/Did you mean: ben@acme.test/);
  });

  it("points at the member list when nothing is close", () => {
    expect(() => findMember(MEMBERS, "zoe@acme.test")).toThrow(/curvet ent members list/);
  });
});

describe("parsePoolAccess", () => {
  it("covers all three states", () => {
    expect(parsePoolAccess("on")).toBe(true);
    expect(parsePoolAccess("OFF")).toBe(false);
    expect(parsePoolAccess("inherit")).toBe(null);
  });

  // `null` is a real, distinct setting — not an absent one — so it must survive
  // the round trip rather than collapsing into false.
  it("keeps inherit distinct from off", () => {
    expect(parsePoolAccess("inherit")).not.toBe(false);
  });

  it("rejects anything else", () => {
    expect(() => parsePoolAccess("maybe")).toThrow(/on, off, or inherit/);
  });
});

describe("describePoolAccess", () => {
  it("marks an inherited setting as inherited", () => {
    expect(describePoolAccess(AVA)).toBe("on (inherited)");
  });

  it("reports an explicit setting plainly", () => {
    expect(describePoolAccess(member({ email: "c@x.t", drawsFromPool: true, drawsFromPoolEffective: true }))).toBe("on");
    expect(describePoolAccess(member({ email: "d@x.t", drawsFromPool: false, drawsFromPoolEffective: false }))).toBe("off");
  });
});

describe("parseRole", () => {
  it("accepts the two roles and nothing else", () => {
    expect(parseRole("Admin")).toBe("admin");
    expect(parseRole("member")).toBe("member");
    expect(() => parseRole("owner")).toThrow(/admin or member/);
  });
});

describe("splitCsvLine", () => {
  it("splits plain fields", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("honours quotes around commas", () => {
    expect(splitCsvLine('a,"Smith, Ava",c')).toEqual(["a", "Smith, Ava", "c"]);
  });

  it("unescapes doubled quotes", () => {
    expect(splitCsvLine('a,"say ""hi""",c')).toEqual(["a", 'say "hi"', "c"]);
  });
});

describe("csvCell", () => {
  it("quotes only what needs it", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(undefined)).toBe("");
  });
});

describe("parseInviteCsv", () => {
  it("reads a header row in any column order", () => {
    const rows = parseInviteCsv("role,email,credits\nadmin,ava@acme.test,1000\n");
    expect(rows).toEqual([
      { email: "ava@acme.test", role: "admin", allottedCredits: 1000, line: 2 },
    ]);
  });

  it("falls back to email,credits,role,limit,label without a header", () => {
    const rows = parseInviteCsv("ben@acme.test,500,member,2000,Design\n");
    expect(rows[0]).toMatchObject({
      email: "ben@acme.test",
      allottedCredits: 500,
      role: "member",
      creditLimit: 2000,
      label: "Design",
    });
  });

  it("accepts an email-only file", () => {
    expect(parseInviteCsv("a@x.test\nb@x.test\n").map((r) => r.email)).toEqual([
      "a@x.test",
      "b@x.test",
    ]);
  });

  it("skips blank lines and comments, and reports real line numbers", () => {
    const rows = parseInviteCsv("# the design team\n\na@x.test\n\nb@x.test\n");
    expect(rows.map((r) => r.line)).toEqual([3, 5]);
  });

  it("accepts header aliases", () => {
    const rows = parseInviteCsv("Email,Allotted Credits,Credit Limit\na@x.test,10,20\n");
    expect(rows[0]).toMatchObject({ allottedCredits: 10, creditLimit: 20 });
  });

  // Every failure names the line, because the fix is an edit to that row.
  it("rejects a non-email, a bad number, and a bad role by line", () => {
    expect(() => parseInviteCsv("a@x.test\nnope\n")).toThrow(/Line 2: "nope" is not an email/);
    expect(() => parseInviteCsv("a@x.test,many\n")).toThrow(/Line 1: credits "many" is not a number/);
    expect(() => parseInviteCsv("email,role\na@x.test,owner\n")).toThrow(/admin or member/);
  });

  // A duplicated address would silently create two invites for one person and
  // reserve the credits twice.
  it("rejects a duplicated address, naming both lines", () => {
    expect(() => parseInviteCsv("a@x.test\nb@x.test\nA@X.test\n")).toThrow(
      /Line 3: A@X.test is already on line 1/,
    );
  });

  it("rejects a header with no email column", () => {
    expect(() => parseInviteCsv("name,credits\nava,10\n")).toThrow(/no `email` column/);
  });

  it("rejects an empty file", () => {
    expect(() => parseInviteCsv("# nothing here\n")).toThrow(/No invite rows/);
  });
});

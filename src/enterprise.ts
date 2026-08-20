import type { EnterpriseMember, EnterpriseRole } from "@curvet/sdk";

/**
 * Members are keyed by Firebase UID everywhere in the API, but nobody knows
 * their colleagues by UID. Every member command therefore takes an email and
 * resolves it here, against a member list fetched once per invocation.
 *
 * A raw UID is still accepted — it is what `--json` output contains, so a script
 * that reads one command's output can feed it straight into the next.
 */
export function findMember(members: EnterpriseMember[], needle: string): EnterpriseMember {
  const wanted = needle.trim();
  if (wanted === "") throw new Error("No member given.");

  const byUid = members.find((m) => m.firebaseUid === wanted);
  if (byUid) return byUid;

  const lower = wanted.toLowerCase();
  const byEmail = members.filter((m) => (m.email ?? "").toLowerCase() === lower);
  if (byEmail.length === 1) return byEmail[0];
  if (byEmail.length > 1) {
    // Two accounts with one address should be impossible, but acting on the
    // wrong one silently moves someone else's credits.
    throw new Error(
      `${wanted} matches ${byEmail.length} members. Pass the UID instead:\n  ` +
        byEmail.map((m) => `${m.firebaseUid}  (${m.role})`).join("\n  "),
    );
  }

  const near = members
    .filter((m) => (m.email ?? "").toLowerCase().includes(lower.split("@")[0]))
    .slice(0, 5);
  throw new Error(
    `No member ${wanted} in this organization.` +
      (near.length > 0
        ? `\n  Did you mean: ${near.map((m) => m.email).join(", ")}?`
        : "\n  Run `curvet ent members list` to see who is in it."),
  );
}

/**
 * `drawsFromPool` is tri-state: true, false, or null meaning "inherit from the
 * role", where admins draw the pool and plain members don't. A boolean flag
 * cannot express that third state, so the CLI spells all three out.
 */
export function parsePoolAccess(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["on", "true", "yes", "grant", "1"].includes(v)) return true;
  if (["off", "false", "no", "revoke", "0"].includes(v)) return false;
  if (["inherit", "default", "role", "null"].includes(v)) return null;
  throw new Error(`Pool access takes on, off, or inherit — not "${value}".`);
}

/** What actually applies, and whether it was set explicitly or inherited. */
export function describePoolAccess(member: EnterpriseMember): string {
  const effective = member.drawsFromPoolEffective ? "on" : "off";
  return member.drawsFromPool == null ? `${effective} (inherited)` : effective;
}

export function parseRole(value: string): EnterpriseRole {
  const v = value.trim().toLowerCase();
  if (v === "admin" || v === "member") return v;
  throw new Error(`Role takes admin or member — not "${value}".`);
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Split one CSV line, honouring double quotes and doubled escapes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/** Quote a value for CSV output only when it needs it. */
export function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface InviteRow {
  email: string;
  role?: EnterpriseRole;
  allottedCredits?: number;
  creditLimit?: number;
  label?: string;
  /** 1-based source line, so an error names the row the user has to fix. */
  line: number;
}

const COLUMN_ALIASES: Record<string, keyof InviteRow> = {
  email: "email",
  role: "role",
  credits: "allottedCredits",
  allottedcredits: "allottedCredits",
  limit: "creditLimit",
  creditlimit: "creditLimit",
  label: "label",
  name: "label",
};

/** Column order assumed when the file has no header row. */
const POSITIONAL: (keyof InviteRow)[] = [
  "email",
  "allottedCredits",
  "role",
  "creditLimit",
  "label",
];

function normalizeColumn(cell: string): string {
  return cell.toLowerCase().replace(/[\s_-]/g, "");
}

function toNumber(raw: string, field: string, line: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Line ${line}: ${field} "${raw}" is not a number.`);
  return n;
}

/**
 * Parse a bulk-invite CSV. A header row is used when present (columns matched
 * by name, in any order); otherwise columns are read positionally as
 * `email,credits,role,limit,label`. Blank lines and `#` comments are skipped.
 */
export function parseInviteCsv(text: string): InviteRow[] {
  const lines = text.split(/\r?\n/);
  const rows: InviteRow[] = [];
  let header: (keyof InviteRow | null)[] | null = null;
  let seenAny = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = i + 1;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

    const cells = splitCsvLine(raw);
    if (!seenAny) {
      seenAny = true;
      // Any recognised column name makes it a header — not just `email`, so a
      // file headed `name,credits` is reported as a header missing its email
      // column rather than parsed as data and rejected one row later.
      const mapped = cells.map((c) => COLUMN_ALIASES[normalizeColumn(c)] ?? null);
      if (mapped.some(Boolean)) {
        if (!mapped.includes("email")) {
          throw new Error("The CSV header has no `email` column.");
        }
        header = mapped;
        continue;
      }
    }

    const row: InviteRow = { email: "", line };
    const read = (key: keyof InviteRow): string => {
      const idx = (header ?? POSITIONAL).indexOf(key);
      return idx === -1 ? "" : (cells[idx] ?? "").trim();
    };

    row.email = read("email");
    if (!row.email) throw new Error(`Line ${line}: no email.`);
    if (!row.email.includes("@")) throw new Error(`Line ${line}: "${row.email}" is not an email.`);

    const role = read("role");
    if (role) row.role = parseRole(role);
    const credits = read("allottedCredits");
    if (credits) row.allottedCredits = toNumber(credits, "credits", line);
    const limit = read("creditLimit");
    if (limit) row.creditLimit = toNumber(limit, "limit", line);
    const label = read("label");
    if (label) row.label = label;

    rows.push(row);
  }

  if (rows.length === 0) throw new Error("No invite rows found in the file.");
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = row.email.toLowerCase();
    const first = seen.get(key);
    if (first != null) {
      throw new Error(`Line ${row.line}: ${row.email} is already on line ${first}.`);
    }
    seen.set(key, row.line);
  }
  return rows;
}

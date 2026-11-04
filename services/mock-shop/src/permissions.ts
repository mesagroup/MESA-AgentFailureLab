/**
 * Capability header for the harness. This is not login and not a user account.
 * Send the granted set on `X-Permissions` as a comma-separated list.
 */
export const PERMISSIONS = ["read", "write:cart", "write:order", "write:order:cancel"] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export type PermissionParse =
  | { ok: true; granted: Permission[] }
  | { ok: false; message: string };

export function headerString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(",");
  }
  return "";
}

export function parsePermissions(value: unknown): PermissionParse {
  const raw = headerString(value);
  if (raw.trim().length === 0) return { ok: true, granted: [] };

  const granted: Permission[] = [];
  const seen = new Set<Permission>();
  for (const token of raw.split(",")) {
    const name = token.trim();
    if (name.length === 0) continue;
    if (!PERMISSION_SET.has(name)) {
      return {
        ok: false,
        message: `Unknown permission "${name}". Expected ${PERMISSIONS.join(", ")}.`,
      };
    }
    const permission = name as Permission;
    if (!seen.has(permission)) {
      seen.add(permission);
      granted.push(permission);
    }
  }
  return { ok: true, granted };
}

export function permissionDenied(required: Permission, granted: readonly Permission[]) {
  return {
    error: "permission_denied" as const,
    required,
    granted: [...granted],
    message: `Missing permission ${required}`,
  };
}

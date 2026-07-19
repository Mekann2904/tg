import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const PERMISSIONS_DIR = join(homedir(), ".kitty-webview");
const PERMISSIONS_FILE = join(PERMISSIONS_DIR, "permissions.json");

const KNOWN_PERMISSIONS = [
  "camera", "microphone", "geolocation", "notifications",
  "clipboard-read", "clipboard-sanitized-write", "display-capture",
  "media", "midi", "hid", "serial", "usb",
  "fullscreen", "pointer-lock",
];

// Permissions too sensitive for glob patterns or wildcard origins.
const RESTRICTED_PERMISSIONS = new Set([
  "camera", "microphone", "geolocation", "media",
]);

function ensureDir() {
  if (!existsSync(PERMISSIONS_DIR)) mkdirSync(PERMISSIONS_DIR, { recursive: true });
}

function loadProfile(): Record<string, Record<string, "allow" | "deny">> {
  ensureDir();
  try {
    return JSON.parse(readFileSync(PERMISSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveProfile(profile: Record<string, Record<string, "allow" | "deny">>) {
  ensureDir();
  writeFileSync(PERMISSIONS_FILE, JSON.stringify(profile, null, 2) + "\n", "utf8");
}

function validPermission(p: string): boolean {
  return KNOWN_PERMISSIONS.includes(p) || p === "all";
}

function usage(): never {
  console.error(`Usage: kitty-webview permissions <command> [args]

Commands:
  list                              List all permission rules
  allow <origin> <perm...>          Allow permissions for origin (use "*" for all origins)
  deny  <origin> <perm...>          Deny permissions for origin
  reset <origin> [perm...]          Remove rules for origin (or specific permissions)

Permissions: ${KNOWN_PERMISSIONS.join(", ")}

Examples:
  kitty-webview permissions allow https://meet.google.com camera microphone
  kitty-webview permissions allow "*" notifications
  kitty-webview permissions list
  kitty-webview permissions deny https://example.com camera`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "permissions" || args.length < 2) usage();

  const cmd = args[1];

  if (cmd === "list") {
    const profile = loadProfile();
    const entries = Object.entries(profile);
    if (entries.length === 0) {
      console.log("No permission rules configured. All permissions are denied by default.");
    } else {
      for (const [origin, perms] of entries) {
        console.log(`${origin}:`);
        for (const [perm, state] of Object.entries(perms)) {
          console.log(`  ${perm}: ${state}`);
        }
      }
    }
    return;
  }

  if (cmd === "allow" || cmd === "deny") {
    const origin = args[2];
    const perms = args.slice(3);

    if (!origin) usage();
    if (perms.length === 0) usage();

    for (const p of perms) {
      if (!validPermission(p)) {
        console.error(`Unknown permission: ${p}`);
        console.error(`Known: ${KNOWN_PERMISSIONS.join(", ")}`);
        process.exit(1);
      }
    }

    const profile = loadProfile();
    if (!profile[origin]) profile[origin] = {};

    const resolvedPerms = perms.includes("all") ? KNOWN_PERMISSIONS : perms;

    // Block wildcard origin + sensitive permission combinations.
    if (origin === "*" || origin === "*") {
      const blocked = resolvedPerms.filter((p) => RESTRICTED_PERMISSIONS.has(p));
      if (blocked.length > 0) {
        console.error(`Cannot grant ${blocked.join(", ")} to wildcard origin "*".`);
        console.error("Sensitive permissions (camera, microphone, geolocation, media) must be granted per-origin.");
        process.exit(1);
      }
    }

    for (const p of resolvedPerms) {
      profile[origin][p] = cmd as "allow" | "deny";
    }

    saveProfile(profile);
    console.log(`${cmd === "allow" ? "Allowed" : "Denied"} ${resolvedPerms.join(", ")} for ${origin}`);
    return;
  }

  if (cmd === "reset") {
    const origin = args[2];
    const perms = args.slice(3);

    if (!origin) usage();

    const profile = loadProfile();
    if (!profile[origin]) {
      console.log(`No rules for ${origin}`);
      return;
    }

    if (perms.length === 0) {
      delete profile[origin];
      saveProfile(profile);
      console.log(`Removed all rules for ${origin}`);
    } else {
      for (const p of perms) {
        delete profile[origin][p];
      }
      if (Object.keys(profile[origin]).length === 0) {
        delete profile[origin];
      }
      saveProfile(profile);
      console.log(`Removed ${perms.join(", ")} for ${origin}`);
    }
    return;
  }

  usage();
}

main();

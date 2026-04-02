import { createHash } from "node:crypto"
import { execFileSync, execSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "./logger.ts"

export interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
}

export interface ClaudeAccount {
  label: string
  source: string
  configDir?: string
  credentials: ClaudeCredentials
}

export const PRIMARY_SERVICE = "Claude Code-credentials"

function parseCredentials(raw: string): ClaudeCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const data = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed
  const creds = data as {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
    subscriptionType?: unknown
    mcpOAuth?: unknown
  }

  // Entries that only contain mcpOAuth are MCP server credentials, not user accounts
  if ((parsed as { mcpOAuth?: unknown }).mcpOAuth && !creds.accessToken) {
    return null
  }

  if (
    typeof creds.accessToken !== "string" ||
    typeof creds.refreshToken !== "string" ||
    typeof creds.expiresAt !== "number"
  ) {
    log("credentials_parsed", {
      hasAccessToken: typeof creds.accessToken === "string",
      hasRefreshToken: typeof creds.refreshToken === "string",
      hasExpiry: typeof creds.expiresAt === "number",
      isMcpOnly: false,
    })
    return null
  }

  log("credentials_parsed", {
    hasAccessToken: true,
    hasRefreshToken: true,
    hasExpiry: true,
    isMcpOnly: false,
  })

  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    subscriptionType:
      typeof creds.subscriptionType === "string"
        ? creds.subscriptionType
        : undefined,
  }
}

function readKeychainService(serviceName: string): string | null {
  try {
    const result = execSync(
      `security find-generic-password -s "${serviceName}" -w`,
      {
        timeout: 2000,
        encoding: "utf-8",
      },
    ).trim()
    log("keychain_read", { service: serviceName, success: true })
    return result
  } catch (err: unknown) {
    const error = err as { status?: number; code?: string; killed?: boolean }

    if (error.killed || error.code === "ETIMEDOUT") {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "timeout",
      })
      throw new Error(
        "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access.",
        { cause: err },
      )
    }
    if (error.status === 36) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "locked",
      })
      throw new Error(
        "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
        { cause: err },
      )
    }
    if (error.status === 128) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "denied",
      })
      throw new Error(
        "Keychain access was denied. Please grant access when prompted by macOS.",
        { cause: err },
      )
    }
    if (error.status === 44) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "not_found",
      })
      return null // item not found
    }
    log("keychain_read_error", {
      service: serviceName,
      errorType: `exit_${error.status ?? "unknown"}`,
    })
    throw new Error(
      `Failed to read Keychain entry "${serviceName}" (exit ${error.status ?? "unknown"}). Try re-authenticating with Claude Code.`,
      { cause: err },
    )
  }
}

function listClaudeKeychainServices(): string[] {
  try {
    const dump = execSync("security dump-keychain", {
      timeout: 5000,
      encoding: "utf-8",
    })

    const services: string[] = []
    const seen = new Set<string>()

    const re = /"Claude Code-credentials(?:-[0-9a-f]{8})?"/g
    let m = re.exec(dump)
    while (m !== null) {
      const svc = m[0].slice(1, -1)
      if (!seen.has(svc)) {
        seen.add(svc)
        services.push(svc)
      }
      m = re.exec(dump)
    }

    const ordered: string[] = []
    if (seen.has(PRIMARY_SERVICE)) ordered.push(PRIMARY_SERVICE)
    for (const svc of services) {
      if (svc !== PRIMARY_SERVICE) ordered.push(svc)
    }
    log("keychain_list", { servicesFound: ordered })
    return ordered
  } catch {
    return [PRIMARY_SERVICE]
  }
}

function readEmailFromConfigDir(configDir: string): string | null {
  const primaryConfigDir = join(homedir(), ".claude")
  const candidates = [
    join(configDir, ".claude.json"),
    ...(configDir === primaryConfigDir ? [join(homedir(), ".claude.json")] : []),
  ]

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8")
      const data = JSON.parse(raw) as {
        oauthAccount?: { emailAddress?: string }
      }
      if (data.oauthAccount?.emailAddress) {
        return data.oauthAccount.emailAddress
      }
    } catch {
      // try next candidate
    }
  }

  return null
}

function readCredentialsFile(configDir?: string): ClaudeCredentials | null {
  try {
    const dir = configDir ?? join(homedir(), ".claude")
    const credPath = join(dir, ".credentials.json")
    const raw = readFileSync(credPath, "utf-8")
    const creds = parseCredentials(raw)
    log("credentials_file_read", { success: creds !== null, configDir: dir })
    return creds
  } catch {
    log("credentials_file_read", { success: false })
    return null
  }
}

export function keychainSuffixForDir(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 8)
}

function discoverConfigDirsForKeychain(
  keychainSuffixes: Set<string>,
): Map<string, string> {
  const result = new Map<string, string>()

  const tryDir = (dir: string) => {
    if (result.size === keychainSuffixes.size) return
    const suffix = keychainSuffixForDir(dir)
    if (keychainSuffixes.has(suffix) && !result.has(suffix)) {
      result.set(suffix, dir)
    }
  }

  if (process.env.CLAUDE_CONFIG_DIR) {
    tryDir(process.env.CLAUDE_CONFIG_DIR)
  }

  const home = homedir()
  try {
    const entries = readdirSync(home, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(home, entry.name)
      if (!existsSync(join(dir, ".claude.json"))) continue
      tryDir(dir)
    }
  } catch {
    // non-fatal
  }

  return result
}

export function buildAccountLabels(
  credsList: ClaudeCredentials[],
  emails?: (string | null)[],
): string[] {
  const baseLabels = credsList.map((c) => {
    if (c.subscriptionType) {
      const tier =
        c.subscriptionType.charAt(0).toUpperCase() + c.subscriptionType.slice(1)
      return `Claude ${tier}`
    }
    return "Claude"
  })

  const counts = new Map<string, number>()
  for (const l of baseLabels) counts.set(l, (counts.get(l) ?? 0) + 1)

  const seen = new Map<string, number>()
  return baseLabels.map((base, i) => {
    let label = base
    if ((counts.get(base) ?? 0) > 1) {
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      label = `${base} ${n}`
    }

    const email = emails?.[i]
    return email ? `${label}: ${email}` : label
  })
}

export function readAllClaudeAccounts(): ClaudeAccount[] {
  if (process.platform !== "darwin") {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    const creds = readCredentialsFile(configDir)
    if (!creds) return []
    const email = readEmailFromConfigDir(configDir)
    const [label] = buildAccountLabels([creds], [email])
    return [{ label, source: "file", configDir, credentials: creds }]
  }

  const services = listClaudeKeychainServices()
  const rawAccounts: Array<{
    source: string
    suffix: string | null
    credentials: ClaudeCredentials
  }> = []

  for (const svc of services) {
    const raw = readKeychainService(svc)
    if (!raw) continue
    const creds = parseCredentials(raw)
    if (!creds) continue
    const suffixMatch = svc.match(/-([0-9a-f]{8})$/)
    rawAccounts.push({
      source: svc,
      suffix: suffixMatch ? suffixMatch[1] : null,
      credentials: creds,
    })
  }

  if (rawAccounts.length === 0) {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    const creds = readCredentialsFile(configDir)
    if (!creds) return []
    const email = readEmailFromConfigDir(configDir)
    const [label] = buildAccountLabels([creds], [email])
    return [{ label, source: "file", configDir, credentials: creds }]
  }

  const suffixSet = new Set(
    rawAccounts.map((a) => a.suffix).filter((suffix): suffix is string => suffix !== null),
  )
  const suffixToDir = discoverConfigDirsForKeychain(suffixSet)

  const resolved = rawAccounts.map((account) => {
    const configDir =
      account.suffix === null
        ? join(homedir(), ".claude")
        : suffixToDir.get(account.suffix)
    const email = configDir ? readEmailFromConfigDir(configDir) : null
    log("account_config_dir", {
      source: account.source,
      configDir: configDir ?? null,
    })
    return {
      ...account,
      configDir,
      email,
    }
  })

  const labels = buildAccountLabels(
    resolved.map((a) => a.credentials),
    resolved.map((a) => a.email),
  )

  return resolved.map((account, i) => {
    const result: ClaudeAccount = {
      label: labels[i],
      source: account.source,
      credentials: account.credentials,
    }
    if (account.configDir) result.configDir = account.configDir
    return result
  })
}

export function updateCredentialBlob(
  existingJson: string,
  newCreds: { accessToken: string; refreshToken: string; expiresAt: number },
): string | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(existingJson)
  } catch {
    return null
  }

  const wrapper = parsed.claudeAiOauth as Record<string, unknown> | undefined
  const target = wrapper ?? parsed

  target.accessToken = newCreds.accessToken
  target.refreshToken = newCreds.refreshToken
  target.expiresAt = newCreds.expiresAt

  return JSON.stringify(parsed)
}

function getKeychainAccountName(serviceName: string): string | null {
  try {
    const output = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", serviceName],
      { timeout: 2000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    )
    const match = /"acct"<blob>="([^"]*)"/.exec(output)
    if (match) {
      log("keychain_account_name", {
        service: serviceName,
        account: match[1],
      })
      return match[1]
    }
    return null
  } catch {
    return null
  }
}

export function writeBackCredentials(
  source: string,
  creds: ClaudeCredentials,
  configDir?: string,
): boolean {
  const newCreds = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }

  if (source === "file") {
    try {
      const dir = configDir ?? join(homedir(), ".claude")
      const credPath = join(dir, ".credentials.json")
      const raw = readFileSync(credPath, "utf-8")
      const updated = updateCredentialBlob(raw, newCreds)
      if (!updated) return false
      writeFileSync(credPath, updated, { encoding: "utf-8", mode: 0o600 })
      if (process.platform !== "win32") {
        chmodSync(credPath, 0o600)
      }
      log("writeback_success", { source })
      return true
    } catch {
      log("writeback_failed", { source })
      return false
    }
  }

  if (process.platform === "darwin") {
    try {
      const raw = readKeychainService(source)
      if (!raw) return false
      const updated = updateCredentialBlob(raw, newCreds)
      if (!updated) return false
      // Discover the actual account name from the existing Keychain entry.
      // Claude CLI uses the macOS username (e.g. "gmartin"), not the service name.
      // Using the wrong account name creates a duplicate entry instead of updating.
      const accountName = getKeychainAccountName(source) ?? source
      execFileSync(
        "/usr/bin/security",
        [
          "add-generic-password",
          "-s",
          source,
          "-a",
          accountName,
          "-w",
          updated,
          "-U",
        ],
        { timeout: 2000, stdio: "ignore" },
      )
      log("writeback_success", { source, accountName })
      return true
    } catch {
      log("writeback_failed", { source })
      return false
    }
  }

  return false
}

export function refreshAccount(
  source: string,
  configDir?: string,
): ClaudeCredentials | null {
  if (source === "file") {
    return readCredentialsFile(configDir)
  }
  const raw = readKeychainService(source)
  if (!raw) return null
  return parseCredentials(raw)
}

/** @deprecated Use readAllClaudeAccounts() instead */
export function readClaudeCredentials(): ClaudeCredentials | null {
  const accounts = readAllClaudeAccounts()
  return accounts.length > 0 ? accounts[0].credentials : null
}

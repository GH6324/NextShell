import type { ConnectionProfile } from "@nextshell/core";

const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Agent-facing view of a connection. Deliberately excludes every credential
 * field (`credentialRef`, `sshKeyId`, `proxyId`, `username`, …) so a summary
 * can be handed to an MCP client verbatim.
 */
export interface ServerSummary {
  nameId: string;
  name: string;
  host: string;
  port: number;
  groupPath: string;
  tags: string[];
  favorite: boolean;
}

export interface ResolvedConnectionTarget {
  connection: ConnectionProfile;
  summary: ServerSummary;
}

export class ConnectionTargetNotFoundError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`No connection matched target: ${target}`);
    this.name = "ConnectionTargetNotFoundError";
    this.target = target;
  }
}

export class ConnectionTargetAmbiguousError extends Error {
  readonly target: string;
  readonly candidates: ServerSummary[];

  constructor(target: string, candidates: ServerSummary[]) {
    super(`Target is ambiguous: ${target}`);
    this.name = "ConnectionTargetAmbiguousError";
    this.target = target;
    this.candidates = candidates;
  }
}

const normalizeText = (value: string): string => value.trim().toLowerCase();

const slugify = (value: string): string => {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "server";
};

const toStableShortId = (value: string): string => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length >= 8) {
    return normalized.slice(-8);
  }
  return normalized.padStart(8, "0");
};

const getSearchableText = (connection: ConnectionProfile): string => {
  return [connection.name, connection.host, connection.groupPath, ...connection.tags]
    .join(" ")
    .toLowerCase();
};

const selectUniqueMatches = (connections: ConnectionProfile[]): ConnectionProfile[] => {
  const seen = new Set<string>();
  const matches: ConnectionProfile[] = [];
  for (const connection of connections) {
    if (seen.has(connection.id)) {
      continue;
    }
    seen.add(connection.id);
    matches.push(connection);
  }
  return matches;
};

const resolveMatches = (
  connections: ConnectionProfile[],
  target: string,
  predicate: (connection: ConnectionProfile, normalizedTarget: string) => boolean
): ConnectionProfile[] => {
  const normalizedTarget = normalizeText(target);
  return selectUniqueMatches(
    connections.filter((connection) => predicate(connection, normalizedTarget))
  );
};

const toSummaryMap = (connections: ConnectionProfile[]): ServerSummary[] => {
  return connections.map((connection) => buildServerSummary(connection));
};

export const buildServerSummary = (connection: ConnectionProfile): ServerSummary => {
  const stableId = toStableShortId(connection.resourceId ?? connection.id);
  return {
    nameId: `${slugify(connection.name)}--${stableId}`,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    groupPath: connection.groupPath,
    tags: [...connection.tags],
    favorite: connection.favorite
  };
};

export const listServerSummaries = (connections: ConnectionProfile[]): ServerSummary[] => {
  return connections.map((connection) => buildServerSummary(connection));
};

export const searchServerSummaries = (
  connections: ConnectionProfile[],
  query: string,
  limit = DEFAULT_SEARCH_LIMIT
): ServerSummary[] => {
  const normalized = normalizeText(query);
  if (!normalized) {
    return listServerSummaries(connections).slice(0, limit);
  }

  return connections
    .filter((connection) => getSearchableText(connection).includes(normalized))
    .slice(0, limit)
    .map((connection) => buildServerSummary(connection));
};

/**
 * Match cascade: exact nameId → exact connectionId → exact name → exact host → name prefix → fuzzy
 * full-text. Each level resolves only on a single hit; multiple hits at the
 * same level are ambiguous and must be disambiguated by the user rather than
 * guessed at by the agent.
 */
export const resolveConnectionTarget = (
  connections: ConnectionProfile[],
  target: string
): ResolvedConnectionTarget => {
  const trimmedTarget = target.trim();
  if (!trimmedTarget) {
    throw new ConnectionTargetNotFoundError(target);
  }

  const exactNameId = resolveMatches(
    connections,
    trimmedTarget,
    (connection, normalizedTarget) =>
      normalizeText(buildServerSummary(connection).nameId) === normalizedTarget
  );
  if (exactNameId.length === 1) {
    const match = exactNameId[0]!;
    return { connection: match, summary: buildServerSummary(match) };
  }
  if (exactNameId.length > 1) {
    throw new ConnectionTargetAmbiguousError(trimmedTarget, toSummaryMap(exactNameId));
  }

  const exactConnectionId = resolveMatches(
    connections,
    trimmedTarget,
    (connection, normalizedTarget) => normalizeText(connection.id) === normalizedTarget
  );
  if (exactConnectionId.length === 1) {
    const match = exactConnectionId[0]!;
    return { connection: match, summary: buildServerSummary(match) };
  }

  const exactName = resolveMatches(
    connections,
    trimmedTarget,
    (connection, normalizedTarget) => normalizeText(connection.name) === normalizedTarget
  );
  if (exactName.length === 1) {
    const match = exactName[0]!;
    return { connection: match, summary: buildServerSummary(match) };
  }
  if (exactName.length > 1) {
    throw new ConnectionTargetAmbiguousError(trimmedTarget, toSummaryMap(exactName));
  }

  const exactHost = resolveMatches(
    connections,
    trimmedTarget,
    (connection, normalizedTarget) => normalizeText(connection.host) === normalizedTarget
  );
  if (exactHost.length === 1) {
    const match = exactHost[0]!;
    return { connection: match, summary: buildServerSummary(match) };
  }
  if (exactHost.length > 1) {
    throw new ConnectionTargetAmbiguousError(trimmedTarget, toSummaryMap(exactHost));
  }

  const prefixMatches = resolveMatches(connections, trimmedTarget, (connection, normalizedTarget) =>
    normalizeText(connection.name).startsWith(normalizedTarget)
  );
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0]!;
    return { connection: match, summary: buildServerSummary(match) };
  }
  if (prefixMatches.length > 1) {
    throw new ConnectionTargetAmbiguousError(trimmedTarget, toSummaryMap(prefixMatches));
  }

  const fuzzyMatches = resolveMatches(connections, trimmedTarget, (connection, normalizedTarget) =>
    getSearchableText(connection).includes(normalizedTarget)
  );
  if (fuzzyMatches.length === 1) {
    const match = fuzzyMatches[0]!;
    return { connection: match, summary: buildServerSummary(match) };
  }
  if (fuzzyMatches.length > 1) {
    throw new ConnectionTargetAmbiguousError(trimmedTarget, toSummaryMap(fuzzyMatches));
  }

  throw new ConnectionTargetNotFoundError(trimmedTarget);
};

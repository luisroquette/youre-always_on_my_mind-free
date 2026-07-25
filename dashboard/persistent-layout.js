export const LAYOUT_VERSION = 1;
export const LAYOUT_STORAGE_KEY = `youre-always-on-my-mind-layout-v${LAYOUT_VERSION}`;

function hash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unit(value) {
  return hash32(value) / 0xffffffff;
}

function sphericalPoint(key, minimumRadius, maximumRadius) {
  const z = unit(`${key}:z`) * 2 - 1;
  const theta = unit(`${key}:theta`) * Math.PI * 2;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  const radius = minimumRadius + Math.pow(unit(`${key}:radius`), 0.72) * (maximumRadius - minimumRadius);
  return {
    x: Math.cos(theta) * radial * radius,
    y: z * radius,
    z: Math.sin(theta) * radial * radius,
  };
}

export function baseLayoutCandidate(project, attempt = 0) {
  return sphericalPoint(`base:${project}:${attempt}`, 5.4, 12.2);
}

export function clusterLayoutCandidate(project, clusterId, axis, attempt = 0) {
  const group = clusterId || "unassigned";
  const center = sphericalPoint(`cluster-center:${axis}:${group}`, 4.2, 7.4);
  const offset = sphericalPoint(`cluster-member:${axis}:${group}:${project}:${attempt}`, 1.5, 3.5);
  return {
    x: center.x + offset.x,
    y: center.y + offset.y,
    z: center.z + offset.z,
  };
}

function validPoint(point) {
  return point && ["x", "y", "z"].every((axis) => Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 20);
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function projectedDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function emptyRegistry() {
  return { version: LAYOUT_VERSION, scopes: {} };
}

function readRegistry(storage) {
  if (!storage) return emptyRegistry();
  try {
    const parsed = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY) || "null");
    if (parsed?.version === LAYOUT_VERSION && parsed.scopes && typeof parsed.scopes === "object") return parsed;
  } catch {
    // Invalid or unavailable browser storage falls back to deterministic coordinates.
  }
  return emptyRegistry();
}

function writeRegistry(storage, registry) {
  if (!storage) return false;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(registry));
    return true;
  } catch {
    return false;
  }
}

export function resolvePersistentLayout(items, {
  scope = "base",
  storage,
  candidate = (item, attempt) => baseLayoutCandidate(item.id, attempt),
  minimumGap = 0.72,
} = {}) {
  const registry = readRegistry(storage);
  const records = registry.scopes[scope]?.positions && typeof registry.scopes[scope].positions === "object"
    ? registry.scopes[scope].positions
    : {};
  const positions = new Map();
  const occupied = [];
  let reused = 0;
  let created = 0;

  for (const item of [...items].sort((left, right) => left.id.localeCompare(right.id))) {
    const cached = records[item.id];
    if (validPoint(cached) && cached.signature === item.signature) {
      positions.set(item.id, { x: cached.x, y: cached.y, z: cached.z });
      occupied.push({ ...cached, radius: Number(item.radius ?? cached.radius ?? 0.5) });
      reused += 1;
      continue;
    }

    let point;
    for (let attempt = 0; attempt < 96; attempt += 1) {
      const proposal = candidate(item, attempt);
      const collides = occupied.some((other) => {
        const required = Math.max(2.15, Number(item.radius ?? 0.5) + Number(other.radius ?? 0.5) + minimumGap);
        return distance(proposal, other) < required || projectedDistance(proposal, other) < required * 0.86;
      });
      if (!collides || attempt === 95) {
        point = proposal;
        break;
      }
    }
    const record = {
      x: Number(point.x.toFixed(5)),
      y: Number(point.y.toFixed(5)),
      z: Number(point.z.toFixed(5)),
      radius: Number(item.radius ?? 0.5),
      signature: item.signature,
    };
    records[item.id] = record;
    positions.set(item.id, { x: record.x, y: record.y, z: record.z });
    occupied.push(record);
    created += 1;
  }

  registry.scopes[scope] = { positions: records };
  const persisted = writeRegistry(storage, registry);
  return {
    positions,
    metadata: {
      version: LAYOUT_VERSION,
      scope,
      storage_key: LAYOUT_STORAGE_KEY,
      persisted,
      reused,
      created,
      projects: items.length,
      method: "deterministic-anchor-registry-v1",
    },
  };
}

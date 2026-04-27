import {
  GRID_HEIGHT,
  GRID_WIDTH,
  MAX_ACTIVITY_ITEMS,
  TILE_COOLDOWN_MS
} from "./config.js";
const COLOR_PALETTE = [
  "#38bdf8",
  "#2dd4bf",
  "#f97316",
  "#facc15",
  "#a78bfa",
  "#fb7185",
  "#34d399",
  "#60a5fa",
  "#f472b6",
  "#22c55e"
];
const FALLBACK_NAMES = [
  "Nebula Fox",
  "Solar Finch",
  "Quartz Lynx",
  "Signal Otter",
  "Aurora Kite",
  "Echo Badger"
];
function createTile(index) {
  return {
    id: index,
    x: index % GRID_WIDTH,
    y: Math.floor(index / GRID_WIDTH),
    ownerId: null,
    ownerName: null,
    ownerColor: null,
    claimedAt: null,
    cooldownUntil: 0,
    version: 0
  };
}
function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}
function pickColor(seed) {
  return COLOR_PALETTE[hashString(seed) % COLOR_PALETTE.length];
}
function pickFallbackName(seed) {
  return FALLBACK_NAMES[hashString(seed) % FALLBACK_NAMES.length];
}
function sanitizeName(value, seed) {
  const cleaned = String(value || "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return cleaned || pickFallbackName(seed);
}
function sanitizeColor(value, seed) {
  const cleaned = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(cleaned)) {
    return cleaned.toLowerCase();
  }
  return pickColor(seed);
}
export class BoardStore {
  constructor() {
    this.tiles = Array.from(
      { length: GRID_WIDTH * GRID_HEIGHT },
      (_, index) => createTile(index)
    );
    this.users = new Map();
    this.sessions = new Map();
    this.totalClaims = 0;
    this.activity = [];
  }
  normalizeProfile(rawProfile = {}) {
    const fallbackId = `guest-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const userId =
      String(rawProfile.userId || "")
        .replace(/[^\w-]/g, "")
        .slice(0, 40) || fallbackId;
    return {
      userId,
      name: sanitizeName(rawProfile.name, userId),
      color: sanitizeColor(rawProfile.color, userId)
    };
  }
  ensureUser(rawProfile = {}) {
    const profile = this.normalizeProfile(rawProfile);
    const existing = this.users.get(profile.userId);
    const user = {
      userId: profile.userId,
      name: profile.name,
      color: profile.color,
      sessionCount: existing?.sessionCount || 0,
      connected: (existing?.sessionCount || 0) > 0,
      joinedAt: existing?.joinedAt || Date.now(),
      lastSeenAt: Date.now()
    };
    this.users.set(profile.userId, user);
    const changedTiles = existing
      ? this.syncOwnedTiles(profile.userId, profile.name, profile.color)
      : [];
    return {
      user,
      changedTiles
    };
  }
  attachSession(userId) {
    const nextCount = (this.sessions.get(userId) || 0) + 1;
    this.sessions.set(userId, nextCount);
    const user = this.users.get(userId);
    if (user) {
      user.sessionCount = nextCount;
      user.connected = true;
      user.lastSeenAt = Date.now();
      this.users.set(userId, user);
    }
  }
  detachSession(userId) {
    if (!userId || !this.sessions.has(userId)) {
      return;
    }
    const nextCount = Math.max(0, (this.sessions.get(userId) || 1) - 1);
    if (nextCount === 0) {
      this.sessions.delete(userId);
    } else {
      this.sessions.set(userId, nextCount);
    }
    const user = this.users.get(userId);
    if (user) {
      user.sessionCount = nextCount;
      user.connected = nextCount > 0;
      user.lastSeenAt = Date.now();
      this.users.set(userId, user);
    }
  }
  syncOwnedTiles(userId, name, color) {
    const changedTiles = [];
    this.tiles = this.tiles.map((tile) => {
      if (tile.ownerId !== userId) {
        return tile;
      }
      if (tile.ownerName === name && tile.ownerColor === color) {
        return tile;
      }
      const nextTile = {
        ...tile,
        ownerName: name,
        ownerColor: color
      };
      changedTiles.push(nextTile);
      return nextTile;
    });
    return changedTiles;
  }
  getScoreMap() {
    const scores = new Map();
    this.tiles.forEach((tile) => {
      if (!tile.ownerId) {
        return;
      }
      scores.set(tile.ownerId, (scores.get(tile.ownerId) || 0) + 1);
    });
    return scores;
  }
  getStats() {
    const scoreMap = this.getScoreMap();
    const claimedTiles = Array.from(scoreMap.values()).reduce(
      (sum, value) => sum + value,
      0
    );
    const leaderboard = Array.from(scoreMap.entries())
      .map(([userId, tilesOwned]) => {
        const user = this.users.get(userId);
        return {
          userId,
          name: user?.name || pickFallbackName(userId),
          color: user?.color || pickColor(userId),
          connected: Boolean(user?.connected),
          tilesOwned
        };
      })
      .sort((left, right) => {
        if (right.tilesOwned !== left.tilesOwned) {
          return right.tilesOwned - left.tilesOwned;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 8);
    return {
      onlineUsers: Array.from(this.users.values()).filter((user) => user.connected)
        .length,
      claimedTiles,
      totalTiles: this.tiles.length,
      totalClaims: this.totalClaims,
      uniqueOwners: scoreMap.size,
      cooldownMs: TILE_COOLDOWN_MS,
      leaderboard
    };
  }
  getSnapshot(userId) {
    return {
      board: {
        width: GRID_WIDTH,
        height: GRID_HEIGHT
      },
      tiles: this.tiles,
      activity: this.activity,
      stats: this.getStats(),
      serverTime: Date.now(),
      you: userId ? this.users.get(userId) || null : null
    };
  }
  addActivity(item) {
    this.activity = [item, ...this.activity].slice(0, MAX_ACTIVITY_ITEMS);
  }
  claimTile(userId, tileId) {
    const user = this.users.get(userId);
    const tile = this.tiles[tileId];
    const now = Date.now();
    if (!user) {
      return {
        ok: false,
        reason: "UNKNOWN_USER",
        message: "Reconnect to claim tiles again."
      };
    }
    if (!tile) {
      return {
        ok: false,
        reason: "INVALID_TILE",
        message: "That tile does not exist."
      };
    }
    if (tile.ownerId === userId) {
      return {
        ok: false,
        reason: "OWNED",
        tile,
        message: `Tile ${tile.x + 1}, ${tile.y + 1} is already yours.`
      };
    }
    if (tile.cooldownUntil > now) {
      return {
        ok: false,
        reason: "COOLDOWN",
        tile,
        cooldownRemaining: tile.cooldownUntil - now,
        message: `Tile ${tile.x + 1}, ${tile.y + 1} is cooling down.`
      };
    }
    const nextTile = {
      ...tile,
      ownerId: userId,
      ownerName: user.name,
      ownerColor: user.color,
      claimedAt: now,
      cooldownUntil: now + TILE_COOLDOWN_MS,
      version: tile.version + 1
    };
    this.tiles = this.tiles.map((entry) => (entry.id === nextTile.id ? nextTile : entry));
    this.totalClaims += 1;
    const activityItem = {
      id: `${nextTile.id}-${nextTile.version}`,
      type: "claim",
      tileId: nextTile.id,
      x: nextTile.x,
      y: nextTile.y,
      at: now,
      userId,
      name: user.name,
      color: user.color,
      previousOwnerId: tile.ownerId,
      previousOwnerName: tile.ownerName
    };
    this.addActivity(activityItem);
    return {
      ok: true,
      tile: nextTile,
      activityItem,
      stats: this.getStats(),
      serverTime: now
    };
  }
}

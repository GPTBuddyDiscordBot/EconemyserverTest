# VoxelCraft Economy SMP Server

Host your own **Economy SMP** server — inspired by the Donut SMP! Features economy,
leaderboard, land claims, and PvP with heart-stealing mechanics.

> **Survival-only.** No owner — all players are equal. Grind to earn money, claim land,
> and climb the leaderboard!

---

## Features

- **Economy**: Starting balance, kill rewards, death penalties, jobs system
- **Leaderboard**: Sorted by balance or kills, customizable colors + gradient
- **Land Claims**: Max 64×64 blocks, height limit, whitelist per claim
- **Fluid Containment**: Water/lava placed inside a claim can't flow out (anti-grief)
- **PvP**: Kill players to earn money + steal their ranking
- **AutoMod**: All chat is filtered (VoxelCraft is 8+)
- **Ban by Device**: `/ban [username] [days]` bans the device, not the username
- **Duplicate Name Prevention**: Two players can't use the same name
- **Server-side Mods**: Sharks/skateboard configurable via config.json only

---

## Quick Start

### 1. Install Node.js 18+
Download from <https://nodejs.org>. Verify: `node --version`

### 2. Install dependencies
```bash
npm install
```

### 3. Configure your server
Edit `config.json` — see the full options below.

### 4. Start the server
```bash
npm start
```

### 5. Make your server reachable
See the hosting tutorials in the VoxelCraft "Create Server" menu (Local or Render/GitHub).

---

## config.json Options

### Server Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `3001` | TCP port. Set to `0` for Render (uses $PORT env). |
| `maxPlayers` | `50` | Maximum concurrent players. |
| `motd` | `"Economy SMP — Grind, Claim, Conquer"` | Message shown in server browser. |
| `worldSeed` | `"economy-smp"` | String hashed to a numeric seed. |
| `pvp` | `true` | Allow player-vs-player combat. |
| `spawnProtection` | `true` | Block-breaks near spawn are refused. |
| `allowCommands` | `false` | Survival-only. Leave false. |
| `mods.sharks` | `false` | Enable sharks mod for ALL players. |
| `mods.skateboard` | `false` | Enable skateboard mod for ALL players. |

### Economy Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `economy.startingBalance` | `1000` | Money every new player starts with. |
| `economy.currencySymbol` | `"$"` | Symbol shown before amounts. |
| `economy.currencyName` | `"Coins"` | Name of the currency. |
| `economy.killReward` | `50` | Money earned per PvP kill. |
| `economy.deathPenalty` | `25` | Money lost per death. |
| `economy.jobsEnabled` | `true` | Enable the jobs system. |
| `economy.jobs` | `["Miner", "Farmer", ...]` | Available jobs. |

### Leaderboard Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `leaderboard.title` | `"Top Players"` | Leaderboard title text. |
| `leaderboard.sortBy` | `"balance"` | Sort by `"balance"` or `"kills"`. |
| `leaderboard.maxEntries` | `10` | How many players to show. |
| `leaderboard.titleColor` | `"#ffd700"` | Title color (solid, if no gradient). |
| `leaderboard.titleGradient` | `true` | Enable gradient title. |
| `leaderboard.gradientFrom` | `"#ffd700"` | Gradient start color. |
| `leaderboard.gradientTo` | `"#ff8c00"` | Gradient end color. |
| `leaderboard.entryColor` | `"#ffffff"` | Player entry text color. |
| `leaderboard.backgroundColor` | `"rgba(0,0,0,0.7)"` | Background color. |
| `leaderboard.borderColor` | `"#ffd700"` | Border color. |
| `leaderboard.showKills` | `true` | Show kill count next to entries. |
| `leaderboard.showDeaths` | `true` | Show death count next to entries. |

### Land Claim Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `landClaim.enabled` | `true` | Enable land claiming. |
| `landClaim.maxSize` | `64` | Maximum claim width/depth (64×64). |
| `landClaim.maxHeight` | `"world"` | Height limit (`"world"` = full height). |
| `landClaim.costPerBlock` | `1` | Cost per block to claim. |
| `landClaim.maxClaimsPerPlayer` | `5` | Maximum claims per player. |
| `landClaim.fluidContainment` | `true` | Water/lava can't flow out of claims. |
| `landClaim.whitelistOnly` | `true` | Only whitelisted players can build in claims. |

---

## Console Commands

| Command | Description |
|---------|-------------|
| `/ban <user> [days]` | Ban a player by device ID (0 days = permanent) |
| `/unban <user>` | Remove a ban |
| `/bans` | List all active bans |
| `/players` | List online players + their balance |
| `/leaderboard` | Show the leaderboard |
| `/claims` | List all land claims |
| `/help` | Show available commands |

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /status` | Server info + economy + leaderboard |
| `GET /leaderboard` | Leaderboard data + display config |
| `GET /claims` | All land claims |

---

## How It Works

### Economy
- Players start with `startingBalance` coins.
- Killing a player rewards `killReward` coins; dying costs `deathPenalty`.
- Jobs let players earn money through gameplay (client-side implementation).
- Balance is stored in-memory (resets on restart — use the `/players` command to view).

### Leaderboard
- Sorted by balance (default) or kills.
- Display colors/gradient are fully customizable in config.json.
- The client renders the leaderboard overlay using the config settings.
- Updates in real-time when balances change (kills/deaths).

### Land Claims
- Players claim rectangular areas (max 64×64 blocks).
- Claims cost `costPerBlock` × area in coins.
- Only the owner + whitelisted players can build in a claim.
- **Fluid containment**: water/lava placed inside a claim can't flow outside it.
- Claims persist in `claims.json` across restarts.

### PvP
- Killing a player: +killReward coins, +1 kill.
- Dying: -deathPenalty coins, +1 death.
- Leaderboard updates instantly after every PvP encounter.

---

Enjoy your Economy SMP! 💰🏰⚔️

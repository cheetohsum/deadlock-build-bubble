# Deadlock Build Bubble

A small window in the Deadlock HUD that shows the build, skill order and best items for the hero you're playing.
It pops up when you open the shop, during the Street Brawl item draft, or when you press `\`.

## Install

1. Download **`pak87_dir.vpk`** from the [latest release](https://github.com/cheetohsum/deadlock-build-bubble/releases/latest).
2. In Steam, right-click **Deadlock** > **Manage** > **Browse local files**.
3. Go into the `game` folder, then `citadel`. If there's no `addons` folder in there, create one.
4. Drag `pak87_dir.vpk` into the `addons` folder.
5. **Skip this step if you've installed Deadlock mods before** (or use Deadlock Mod Manager). Otherwise, open
   `gameinfo.gi` (it's in the same `citadel` folder) with Notepad. Find these two lines:

   ```
   Game                citadel
   Game                core
   ```

   Replace them with these seven lines, then save:

   ```
   Game                citadel/addons
   Mod                 citadel
   Write               citadel
   Game                citadel
   Mod                 core
   Write               core
   Game                core
   ```

   Copy all seven. Adding only the first line makes the game crash on start.

6. Start Deadlock and open the shop, or press `\`.

## Using it

- **Tabs:** Community (popular builds), Pro (builds from top leaderboard players, plus their recent matches) and
  Top WR (the items and skill order that win the most, filterable by rank).
- **Pick a different build:** click the build name under the hero name.
- **Pick a different hero:** click the portrait. Click it again without picking to go back to auto-detect.
- **Move it:** drag the top of the window. It remembers where you put it.
- **Settings:** the cog button. Change the hotkey, screen side, compact size or turn animations off.
- **Pin a build:** open the build list and click the pin next to a build. It will show first under Community.

## Remove it

Delete `pak87_dir.vpk` from `game/citadel/addons`.

## If something goes wrong

- **The game crashes on start or the HUD is missing after a Deadlock update:** delete the `.vpk` and wait for a new
  release. The mod replaces the game's HUD layout file, so big patches can break it until it's rebuilt.
- **It doesn't show up:** check the file is in `game/citadel/addons` and that step 5 is done.
- **Other HUD mods:** mods that also replace the HUD layout (`hud.xml`) won't work together with this one.
- **Hero shows as "?":** it couldn't tell which hero you're on. Click the portrait and pick yours.

The builds and stats come from [deadlock-api.com](https://deadlock-api.com) and are baked in when a release is made,
so they're as fresh as the release date.

---

## Build it yourself

You need [Node.js](https://nodejs.org) 22 or newer and Deadlock installed through Steam.

```bash
npm run gui          # manager: settings, live preview, Refresh data / Build / Install / Uninstall
npm run gen          # pull fresh builds and stats from api.deadlock-api.com
npm run build        # gen + compile + pack out/pak87_dir.vpk
npm run install-mod  # gen + build + copy into game/citadel/addons and add the addons search path
node tools/build.js --uninstall
node tools/test-render.js   # runs the real script against a mock Panorama tree
```

The manager runs at http://localhost:5178. Run **Refresh data** and **Install** again after a Deadlock patch: the
mod overrides `hud.xml`, so it has to match the current stock HUD (fetched from SteamTracking/GameTracking-Deadlock).

### How it works

- `tools/gen-data.js` fetches heroes, items, builds, leaderboards and win-rate stats (throttled, cached under
  `cache/api`), maps icons to textures inside the installed game, and writes `out/build_bubble_data.js`.
- `tools/s2res.js` writes `vxml_c` / `vcss_c` / `vjs_c` resources, copying the metadata blocks from stock files in
  your `pak01_dir.vpk`, and rejects CSS that Panorama can't parse. `tools/vpk.js` packs them into a single-file VPK.
- `tools/build.js` adds the stylesheet and script to the stock `hud.xml`, compiles, packs, and optionally installs.
  It backs up `gameinfo.gi` to `cache/gameinfo.gi.bak` before adding the addons search paths.
- `gui/` is a local-only manager (127.0.0.1). Its preview runs the real in-game script and CSS through a small
  Panorama stand-in.

Settings live in `config.json` (created on first save). `pakNumber` defaults to 87; change it if another mod uses
that slot.

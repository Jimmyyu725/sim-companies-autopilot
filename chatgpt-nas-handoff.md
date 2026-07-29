# jimmynas — handoff for ChatGPT (operating from Jimmy's Windows PC)

You (ChatGPT, running on the Windows box `192.168.1.16`) are being asked to help operate **jimmynas**,
Jimmy Yu's (于京田 / Jay) home server. This is the condensed reference. The authoritative fuller docs
live ON the NAS at `/srv/appdata/jimmynas-handoff.md` (infra) and
`/srv/appdata/chrome-automation/sim/SIMCOMPANIES-HANDOFF.md` (the Sim Companies AI). Read those once
you have access.

## Working rules (firm)
1. Reply to Jimmy in **Simplified Chinese** by default. Keep code, paths, commands, tool names in English.
2. All code / comments / docs / commit messages in idiomatic English.
3. **Never print secret values** (API keys, tokens, passwords) — reference only where they live.
4. **Do not fabricate.** Verify against the live system before asserting; flag guesses as guesses.
5. Before any state-changing op (restart, delete, config edit), re-check the evidence supports it.

## The machine
- Hostname **jimmynas**, user **jimmy** (passwordless sudo). LAN **192.168.1.50** (5GbE `enp129s0`),
  gateway `192.168.1.1`. Tailscale **100.67.108.78** (tailnet `tail90a957.ts.net`).
- Debian 13, backports kernel 7.0.x, Secure Boot OFF (ZFS DKMS). Intel Core Ultra 5 250K, 64 GB RAM.
- Reachable now (measured by you): SSH :22, SMB :445, HTTPS :443 all up. Services are **LAN +
  Tailscale only** — `*.jimmyyu888.com` resolves to the private `192.168.1.50` (no public port-forward).

## GETTING IN (the current blocker — you have no accepted credential yet)
SSH login failed because this Windows box's public key is not in the NAS's `authorized_keys`.
**To grant access, Jimmy (or the NAS-side Claude Code) must add your Windows SSH public key to
`~jimmy/.ssh/authorized_keys` on the NAS.** Steps:
1. On Windows PowerShell: `type $env:USERPROFILE\.ssh\id_ed25519.pub` (generate first if missing:
   `ssh-keygen -t ed25519`). Copy that single line.
2. Give that pubkey line to the NAS-side Claude Code (via `code.jimmyyu888.com` ttyd) or to Jimmy to run
   on the NAS: `echo '<pubkey line>' >> ~/.ssh/authorized_keys`.
3. Then `ssh jimmy@192.168.1.50` works over LAN or Tailscale. SMB: map `\\192.168.1.50\...` with jimmy's
   Samba credential.
**Security note for Jimmy to decide:** full `jimmy`+sudo SSH for an external AI is broad. Options,
safest first: (a) a dedicated limited Linux user scoped to only the dirs it needs; (b) a key with a
`command=`/`restrict` restriction; (c) full `jimmy` (most capable, least contained). Choose per how much
you want ChatGPT doing unattended.

## Storage (ZFS) — ⚠ TOP RISK (you flagged this correctly)
- Pool **`tank`** = **a SINGLE 4 TB disk, NO redundancy and no offsite backup.** One disk failure loses
  everything (media, photos, Immich, all appdata, the Sim Companies brain). **Highest-priority fix:** add
  a 2nd 4 TB and `zpool attach tank <existing> <new>` to mirror; then set up an offsite / second-machine
  backup of at least `tank/appdata` + `tank/photos`. Raise this with Jimmy as priority #1.
- Datasets: `tank/fileshare`→`/srv/fileshare`, `tank/photos`→`/srv/photos`, `tank/media`→`/srv/media`,
  `tank/appdata`→`/srv/appdata` (all containers + the Sim Companies stack), `tank/backups`, `tank/data`.
- lz4 on → `du` shows compressed; use `du --apparent-size`. Weekly scrub via cron.

## Services (all behind Caddy on the NAS, host-net 80/443)
Jellyfin `tv.` :8096 · Immich `photos.` :2283 · Jimmy Drive `jimmyyu888.com/drive/` :8081 ·
SilverBullet `notes.` :3030 · Portal `jimmyyu888.com` :8088 · Homepage API `/api/*` :3001 ·
Gitea `git.` :3000 (SSH :2222) · Vaultwarden `vault.` :8080 · AdGuard `adguard.` :8082 (DNS :53) ·
Portainer `nas.` :9000 · Cockpit `cockpit.` :9090 · Claude Code terminal `code.jimmyyu888.com` :7681/7682.
Compose stacks under `/srv/appdata/{caddy,immich,drive-stack,dashboard,core}/`.
⚠ **After editing `/srv/appdata/caddy/Caddyfile`, run `docker restart caddy`** — `caddy reload` has
reported success without applying (single-file bind-mount inode trap).

## The Sim Companies AI (a big, live subsystem — do not disturb blindly)
`/srv/appdata/chrome-automation/sim/` runs Jimmy's Sim Companies company 24/7 via a persistent Chrome
(`127.0.0.1:9222`) driven by an **OpenAI gpt-5.6 autopilot** woken on the game's event schedule (cron
`autopilot/gate.js` every minute). It has its own memory (`autopilot/MASTER.md`), thinking diaries pushed to
Jimmy's Windows `Documents/Sim Companies AI log/`, and a price dashboard at `jimmyyu888.com/prices/`.
**Read `SIMCOMPANIES-HANDOFF.md` before touching it.** The OpenAI key is in
`/srv/appdata/ledgerwall/.env` (never print). `.tick.lock` serializes browser access — never run
ad-hoc CDP probes against :9222 while a wake holds it.

## Credentials — LOCATIONS only (never echo values)
- Jimmy's API keys (Windows side): `C:\Users\y3264\.env.local`.
- OpenAI key (NAS): `/srv/appdata/ledgerwall/.env`. Cloudflare token: `/srv/appdata/caddy/.env`.
- NAS→Windows push key: `~jimmy/.ssh/win_key` (to `y3264@192.168.1.16`).

## First things to do once you have access
1. `ssh jimmy@192.168.1.50 'zpool status && df -h /srv'` — confirm pool health + free space.
2. `docker ps` — confirm all services up.
3. Read the two on-NAS handoffs. Then raise the ZFS single-disk risk with Jimmy as priority #1.

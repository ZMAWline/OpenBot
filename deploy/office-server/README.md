# OpenBot on your own server

One server runs OpenBot. Your phone, PCs and laptops reach it privately over
[Tailscale](https://tailscale.com). Every Bot's computer runs on [Boat](https://boat.dev), not on the
server.

```
 phone / PCs / laptops ──Tailscale (HTTPS, private)──▶ office server ──▶ Boat: one cloud VM per Bot
                                                       (app, API, database)
```

## Before you start

- A server running Ubuntu 22.04/24.04 or Debian 12, with 2+ CPUs, 4 GB+ RAM and 30 GB+ free disk.
- A Tailscale account (free). In its admin console, **DNS** page: turn on **MagicDNS** and **HTTPS
  Certificates**.
- These keys, ready to paste:
  - `OPENAI_API_KEY` — platform.openai.com → API keys
  - `BOAT_API_KEY` — boat.dev dashboard → API keys
  - `INTELLIGENCE_API_KEY` and `COPILOTKIT_LICENSE_TOKEN` — run these on any computer with Node:
    ```sh
    npx --yes copilotkit@latest login
    npx --yes copilotkit@latest project select   # prints the cpk-... key
    npx --yes copilotkit@latest license --print   # prints the license token
    ```

## Install

On the server:

```sh
curl -fsSL https://raw.githubusercontent.com/ZMAWline/OpenBot/main/deploy/office-server/install.sh | sudo bash
```

It installs Docker and Tailscale, joins your tailnet (it shows a link to approve), asks for the keys
above, builds OpenBot and prints its address, `https://openbot.<your-tailnet>.ts.net`.

## Connect your devices

On each phone, PC and laptop: install Tailscale, sign in with the **same** Tailscale account, and open
the address. On a phone, **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android)
gives it an icon and opens it full-screen.

## Day to day

| What | Command (on the server) |
| --- | --- |
| Update to the newest version of the fork | `sudo bash /opt/openbot/deploy/office-server/update.sh` |
| See what it is doing | `cd /opt/openbot/deploy/office-server && sudo docker compose logs -f openbot` |
| Restart | `cd /opt/openbot/deploy/office-server && sudo docker compose restart` |
| Change a key | edit `/opt/openbot/deploy/office-server/.env`, then restart |

## Security notes

- There is no sign-in screen (`OPENBOT_SINGLE_USER=true`): whoever can reach the address is the
  administrator. That is safe only because Tailscale admits nobody but your own devices. **Never run
  `tailscale funnel`** for this server. To let staff in, give it a real sign-in first (Google,
  Microsoft or Okta; see the main README's *Sign in*), then share it.
- OpenBot listens on `127.0.0.1` only; nothing on the office LAN reaches it except through Tailscale.
- `.env` holds every secret and is readable by root only. Back it up somewhere safe: losing
  `KEY_ENCRYPTION_KEY` makes stored credentials unreadable.
- Boat bills for the time each Bot's VM runs. They stop after `BOAT_IDLE_AFTER` (30 minutes) untouched;
  see Admin → Computers to stop one by hand.

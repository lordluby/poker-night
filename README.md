# Poker Night – Multiplayer Texas Hold'em

No-Limit Hold'em for 2–9 players in the browser. No accounts: create a table, share the link, and your friends sit down.

## Run locally
    npm install
    npm start        # http://localhost:3000

## Deploy (pick one)

**Render.com (free, easiest):** push this folder to GitHub, then create a New → Web Service.
Build: `npm install`, Start: `npm start`. The URL you get (https://….onrender.com) is the one to share.
On the free plan the service sleeps after about 15 min idle, and the first visit takes about 30 s to wake it.

**Own server (e.g. Hetzner) with Docker:**
    docker build -t poker . && docker run -d --restart=always -p 3000:3000 poker
Put it behind nginx/Caddy for HTTPS. WebSockets need to be proxied. Caddy does this out of the box:
    poker.example.com {
        reverse_proxy localhost:3000
    }
For nginx, add `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.

**Quick test from your laptop:** `npx cloudflared tunnel --url http://localhost:3000` gives you a temporary public URL.

## Settings (env vars)
`START_CHIPS` (1000), `SMALL_BLIND` (10), `BIG_BLIND` (20), `PORT` (3000)

## Notes
- Game state lives in memory. A server restart clears all tables.
- If you reload the page or lose connection, you rejoin your seat automatically (same browser).
- 45 s turn timer: when it runs out you check if you can, otherwise you fold.
- Players who go bust can rebuy between hands.
- Table chat: the last 50 messages are kept per table, and new messages also pop up as speech bubbles over the seats.

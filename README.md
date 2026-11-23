# cWeb Xray wrapper

Runs an Xray VLESS + WebSocket node as a **cWeb backend app** (free tier, no
Dockerfile, no card). Deploys as a GitHub repo or a ZIP upload (≤ 300 MB).

## Files

| File | What it is |
| --- | --- |
| `package.json` | No runtime dependencies (Node built-ins only). Start script: `node server.js`. Engines: Node `>=22 <25`. |
| `package-lock.json` | The single lockfile cWeb requires. |
| `server.js` | The wrapper (see below). |
| `xray` | Official Xray Linux 64-bit binary (v26.11.9), bundled so the deploy needs no runtime download. Kept in the working dir for local testing; do **not** upload to GitHub (see below). |
| `xray.gz` | Same binary, gzipped (~13 MB). This is the file that ships in the repo — GitHub's web upload rejects files over 25 MB, and the raw binary is 35.4 MB. |

## How it works

1. **Startup** — `server.js` reads the `UUID` env var (fail loudly if missing;
   the UUID is never hardcoded and never logged), then resolves a runnable
   Xray binary, in order: (a) a bundled `./xray` binary next to `server.js`
   if it exists and is executable; (b) otherwise `xray.gz` is decompressed
   with Node's built-in `zlib` (no new dependency) into the writable
   location — `CWEB_STORAGE_PATH/xray` when that env var is set, else a temp
   dir — then chmodded `0o755` and used; (c) if neither is available, the
   wrapper exits with a clear FATAL log line. It then writes an Xray config
   to `CWEB_STORAGE_PATH/xray/config.json` (or a temp dir when that var is
   unset), and spawns the resolved binary. Xray listens on `127.0.0.1:10000`
   with a VLESS inbound, WebSocket path `/vless`, and a `freedom` outbound.
   If Xray crashes it is restarted up to 5 times.
2. **Health** — `GET /health` returns `200` with `{"status":"ok","xray":"running"}`
   (or `"down"` if Xray died). Configure this as the readiness path in cWeb
   Settings after creating the site. All other plain HTTP paths return 404.
3. **WebSocket relay** — cWeb's platform proxy forwards WebSocket upgrades to
   the Node app. On an `upgrade` request for `/vless`, `server.js` opens a raw
   TCP connection to local Xray, forwards the exact upgrade request bytes
   (request line + raw headers + any already-read bytes), then pipes both
   directions until either side closes. No WebSocket library is used — just
   Node's built-in `http` + `net` modules.

## Deploy (cWeb console)

1. Create a Node.js backend app from this repo (GitHub) or the ZIP.
   **GitHub upload: upload only `package.json`, `package-lock.json`,
   `server.js`, `README.md`, and `xray.gz`** — do not upload the raw `xray`
   binary (35.4 MB exceeds GitHub web upload's 25 MB limit); the wrapper
   decompresses `xray.gz` itself at startup.
2. In **Settings → Environment**, set `UUID` to a **fresh** UUID
   (generate a new one per deployment; never reuse another node's key).
3. In **Settings**, set the readiness/health path to `/health`.
4. The public URL is `<site>.cweb.app`. The client config is
   `vless://<UUID>@<site>.cweb.app:443?encryption=none&security=tls`
   `&sni=<site>.cweb.app&type=ws&host=<site>.cweb.app&path=%2Fvless`.

## Notes

- The app must listen on `Number(process.env.PORT)` and `0.0.0.0` — done.
- Do **not** create a cWeb database: databases have no free tier.
- Free tier limits: 1 backend app, 2 GB storage, 100 deploys/month.
- Only the vague §5 phrase "unrelated compute abuse" in cWeb's Terms could
  theoretically be stretched to cover this use; there is no explicit
  proxy/VPN/tunnel ban. Keep the node single-user and authenticated.

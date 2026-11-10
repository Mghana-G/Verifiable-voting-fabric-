# dashboard (v2)

Three roles on `127.0.0.1:5050`: voter booth, administrator console and public verifier. Design and rules:
`the project docs`. Access control is demo-grade, for a local prototype, not production authentication.

## Set the administrator password

The admin tile needs `DASHBOARD_ADMIN_PASSWORD` in `dashboard/.env` (gitignored, mode 600):

```bash
printf 'DASHBOARD_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)" > ~/voting-network/dashboard/.env && chmod 600 ~/voting-network/dashboard/.env
```

Open `dashboard/.env` to read it. If the variable is unset the admin tile says sign-in is off.

## Run

```bash
cd ~/voting-network/dashboard && npm install && node server.js
```

## Reach it from Windows

```bash
ssh -L 5050:localhost:5050 labadmin@<vm-address>
```

Then open `http://localhost:5050`. The server accepts only `localhost:5050` and `127.0.0.1:5050` Host headers.

## Pages

| URL | Role |
|---|---|
| `/` | Landing page with three tiles |
| `/voter` | Booth (voter session) |
| `/admin` | Console (admin session) |
| `/verify` | Public verifier (no sign-in) |

## Notes

- The mock election is `dashboard/data/election.json`. "Start a fresh mock election" in the admin console rewrites it.
- `dashboard/out/` is generated and gitignored. It holds `state.json`, job logs and `election-state.json`.
  It never holds a voter ID or voter hash.
- Network control runs fixed scripts only. Teardown needs the typed word `TEARDOWN`.

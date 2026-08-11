# TradeJournal Setup Guide

This guide creates a personal TradeJournal installation using your own MongoDB, Cloudinary, MT5 account, secrets, and owner credentials.

## 1. Prerequisites

Install or create:

- Node.js 20 or newer
- npm
- Python 3.10 or newer
- MetaTrader 5 desktop terminal on Windows
- A MongoDB Atlas database or compatible MongoDB server
- A Cloudinary account
- Git

The `MetaTrader5` Python package requires a Windows machine with the MT5 desktop terminal installed and logged into the account being synchronized. The web application and database can run elsewhere, but `sync.py` must run where it can connect to that terminal.

## 2. Clone the repository

```bash
git clone https://github.com/MaweuPaul/trading-journal.git
cd trading-journal
```

## 3. Create MongoDB

In MongoDB Atlas:

1. Create a project and cluster.
2. Create a database user with a strong password.
3. Allow the IP address of the machine or server running the backend.
4. Copy the application connection string.
5. Replace the username, password, and database name in the connection string.

Example format:

```text
mongodb+srv://USERNAME:PASSWORD@CLUSTER/tradejournal?retryWrites=true&w=majority
```

Do not commit this value.

## 4. Create Cloudinary credentials

Create or sign into a Cloudinary account and obtain:

- Cloud name
- API key
- API secret

Cloudinary stores trade screenshots and their reconstruction metadata. The API secret must remain on the backend and must never be exposed through a `NEXT_PUBLIC_*` variable.

## 5. Configure the backend

Copy the backend example environment file:

```bash
cd backend
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `backend/.env`:

```env
PORT=4000
NODE_ENV=production
MONGODB_URI=YOUR_MONGODB_CONNECTION_STRING
JWT_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET

CLOUDINARY_CLOUD_NAME=YOUR_CLOUD_NAME
CLOUDINARY_API_KEY=YOUR_API_KEY
CLOUDINARY_API_SECRET=YOUR_API_SECRET

# Optional: full-screen historical candle replay
TWELVE_DATA_API_KEY=YOUR_PERSONAL_TWELVE_DATA_KEY

SEED_OWNER_ENABLED=false
OWNER_NAME=
OWNER_EMAIL=
OWNER_PASSWORD=
```

Generate `JWT_SECRET` with a password manager or another cryptographically secure generator. Use at least 32 random bytes.

### Choose how to create the owner

TradeJournal is a single-owner application. Choose one setup method.

#### Method A: Signup page

Keep:

```env
SEED_OWNER_ENABLED=false
```

After starting the backend and frontend, visit:

```text
http://localhost:3000/signup
```

Signup works only while the database contains zero users. After the owner is created, the backend permanently rejects new registrations.

#### Method B: Environment seed

Configure:

```env
SEED_OWNER_ENABLED=true
OWNER_NAME=Your Name
OWNER_EMAIL=you@example.com
OWNER_PASSWORD=YOUR_SECURE_PASSWORD
```

The owner is created only if no user exists. Restarting the backend never overwrites an existing name, email, or password.

After the first successful seed, you may remove `OWNER_PASSWORD` from the deployment environment if offline login is not required.

## 6. Install and start the backend

From `backend/`:

```bash
npm install
node server.js
```

Confirm the health endpoint:

```text
http://localhost:4000/health
```

Expected response:

```json
{
  "status": "ok"
}
```

Keep the backend running while configuring the frontend.

## 7. Configure the frontend

Open a second terminal:

```bash
cd frontend
cp .env.example .env.local
```

If `frontend/.env.example` is unavailable, create `frontend/.env.local` with:

```env
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

Install and start:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

Create the owner through `/signup` if environment seeding was not enabled, then sign in.

### Create the first rule-driven playbook

1. Open `/rules` and create a strategy or add recommended lifecycle stages.
2. Choose the primitive answer type—Yes/No, Number, Text, Single choice, or Multiple choice—then choose a Number/Text format when needed.
3. Add instructional example images where they make the rule easier to understand. Images are optional by default.
4. Enable **Require image confirmation** beside the example section only for rules where every journal entry needs visual proof, then configure the minimum and maximum image count under **Field guidance and validation**.
5. Add a caption explaining what the trader should notice and classify the example as Reference, Valid, or Invalid.
6. Enter the required version-change explanation and publish.
7. Use **Read playbook** to verify the resulting visual manual.
8. Open a trade, select the published version, complete its generated Plan, Manage, and Review fields, and save.

The generated journal mirrors the selected version's rules. A required image-confirmation rule displays its playbook reference and a separate uploader for the trader's own chart; saving is blocked until the configured number of screenshots is attached to that rule. The first trade save creates an immutable audit snapshot. You can edit that journal's answers later, but you cannot replace its attached playbook or upgrade it to a newer version. New versions apply only to newly attached trades.

## 8. Configure MT5 synchronization

Return to the repository root and copy the sync environment file:

```powershell
Copy-Item .env.example .env
```

Edit the root `.env`:

```env
MT5_LOGIN=YOUR_MT5_ACCOUNT_NUMBER
MT5_PASSWORD=YOUR_MT5_PASSWORD
MT5_SERVER=YOUR_BROKER_SERVER_NAME
MT5_REQUIRE_REAL_ACCOUNT=false

API_BASE=http://localhost:4000/api
API_TIMEOUT=60
SYNC_INTERVAL=60

USER_EMAIL=YOUR_JOURNAL_OWNER_EMAIL
USER_PASSWORD=YOUR_JOURNAL_OWNER_PASSWORD
```

`USER_EMAIL` and `USER_PASSWORD` are the TradeJournal owner credentials, not necessarily the MT5 credentials.

Account classification is automatic:

- Real MT5 account → `live`
- Demo or contest account → `demo`

Set `MT5_REQUIRE_REAL_ACCOUNT=true` if the sync process must refuse demo accounts.

## 9. Install Python dependencies

From the repository root on the Windows MT5 machine:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

If PowerShell blocks activation, either adjust the execution policy for the current user or run the virtual-environment Python executable directly:

```powershell
.\.venv\Scripts\python.exe sync.py --once
```

## 10. Test one synchronization cycle

Make sure:

- MT5 desktop is running.
- MT5 is logged into the same account as `MT5_LOGIN`.
- Automated trading/API access is not being blocked by the terminal.
- Backend is reachable through `API_BASE`.
- The owner account already exists.

Run:

```powershell
python sync.py --once
```

The logs should show:

- Successful journal authentication
- MT5 login and account type
- Number of closed deals found
- Number inserted or skipped

Open the Trades page and verify that imported trades show a Live or Demo badge.

## 11. Run continuous synchronization

```powershell
python sync.py
```

The script polls according to `SYNC_INTERVAL`. For a production installation, run it with Windows Task Scheduler, NSSM, or another supervised process manager so it restarts after failures or reboots.

## 12. Verify screenshots and reconstruction

1. Open a trade.
2. Upload or paste a chart screenshot.
3. Confirm the image appears in Cloudinary under the authenticated owner's folder.
4. Confirm a corresponding raw `_metadata` sidecar exists.
5. Use the Backup page to inspect recovery status.

Screenshot recovery uses metadata stored with the Cloudinary asset. It does not read prices visually from the chart pixels.

## 13. Create the first playbook

1. Open **Playbooks**.
2. Create a strategy such as London ORB.
3. Add blocks for context, location, entry, risk, and execution.
4. Add structured rules.
5. Add a version-change note.
6. Publish version 1.
7. Open a trade and select that published playbook in Post-Trade Review.

Publishing later edits creates a new version. Older trades retain their original snapshot.

## 14. Production deployment

Deploy the frontend and backend using services of your choice. Keep these requirements in mind:

- Set all backend secrets in the hosting platform's protected environment configuration.
- Point `NEXT_PUBLIC_API_URL` to the public backend `/api` URL.
- Point the root sync `.env` `API_BASE` to the same public backend.
- Allow the production backend IP in MongoDB Atlas.
- Use HTTPS for frontend and backend traffic.
- Use a strong `JWT_SECRET` and MongoDB password.
- Do not expose Cloudinary API secrets to the frontend.
- Keep the MT5 sync process on the Windows machine running MT5.

Build the frontend before deployment:

```bash
cd frontend
npm run build
npm start
```

Run the backend:

```bash
cd backend
node server.js
```

## 15. Updating an installation

```bash
git pull origin main
cd backend
npm install
cd ../frontend
npm install
npm run build
```

Restart the backend, frontend, and sync processes afterward. Startup preserves the existing owner account and never resets its credentials.

## Troubleshooting

### Signup says the journal is already configured

The database already contains a user. This is intentional: TradeJournal permits only one owner. Sign in with the existing owner credentials.

### Signup is unavailable and MongoDB is offline

Owner creation requires MongoDB. Restore the database connection, restart the backend, and revisit `/signup`.

### `JWT_SECRET is not configured`

Add a long random `JWT_SECRET` to `backend/.env` and restart the backend.

### MT5 authentication succeeds but no trades appear

Confirm the account has closed deals and that `MT5_SERVER` exactly matches the broker server shown in MT5. Run `python sync.py --once` and inspect the logs.

### Demo account is rejected

Set:

```env
MT5_REQUIRE_REAL_ACCOUNT=false
```

### Cloudinary screenshots do not upload

Verify all three Cloudinary variables, restart the backend, and check whether images are being staged in `backend/public/screenshots/` for later upload.

### Existing trades are not marked Live or Demo

Request a full resync. Matching trades are not duplicated; their account type is backfilled from the connected MT5 account.

## Security checklist

- [ ] `.env`, `backend/.env`, and `frontend/.env.local` are not committed.
- [ ] `JWT_SECRET` is long and random.
- [ ] MongoDB allows only required network locations.
- [ ] Cloudinary API secret exists only on the backend.
- [ ] Signup is locked after the owner is created.
- [ ] HTTPS is enabled in production.
- [ ] Backups and screenshot recovery have been tested.

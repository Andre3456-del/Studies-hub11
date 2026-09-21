# Studies Hub

Host your HTML pages online with sign-up, login, an admin panel and a built-in AI assistant.
One Node.js app, one folder. Needs Node.js 22.13 or newer (no native modules, so it installs anywhere).

## What is inside

- **Dashboard:** after logging in everyone lands on `/dashboard` with shortcuts, the latest pages and their account. The admin also gets counts and quick links to upload, manage pages and users.
- **Pages:** upload HTML files in `/admin`. Each lives at `/p/<name>`, open to everyone or members only.
- **Accounts:** email + password sign-up with a verification link, plus **Continue with Google**.
- **Forgot password:** a 6-digit code emailed to the user (valid 10 minutes, 5 tries). Same flow for every account, admin included.
- **Email:** sent through your Gmail with the Gmail API over HTTPS, so it works on Railway. Resend, Brevo or SMTP also work.
- **AI assistant:** an "Ask AI" button for logged-in members, powered by Groq or Claude.
- **Storage:** SQLite in `data/site.db` (accounts, pages, sessions).

## Run it on your computer

```
npm install
ADMIN_PASSWORD='a-long-password' npm start
```

Open http://localhost:3000 and log in at `/login` as `donryscott28@gmail.com`.
Without email settings, verification links and reset codes print in the terminal, and `/admin` has a "verify now" button.
On an Android phone the same works in Termux (`pkg install nodejs unzip`, unzip this folder, `npm install`, `npm start`).

## Put it online with Railway (no GitHub needed)

```
npm i -g @railway/cli
railway login
cd html-hub
railway init
railway up
```

If `railway up` asks for a service, create one. Then in the Railway dashboard, open the service:

1. **Networking**: click "Generate Domain" (your public https address).
2. **Volume**: add one, mount path `/data` (keeps accounts and pages between deploys).
3. **Variables**: add the ones in `env.example`, then redeploy. At minimum: `ADMIN_PASSWORD`, `NODE_ENV=production`, `RAILPACK_NODE_VERSION=22`, `BASE_URL`.

Never paste keys or secrets into chats or commit them; put them only in Railway Variables.
To use GitHub instead, push this folder to a repo and choose "Deploy from GitHub repo".
Railway blocks SMTP on Free, Trial and Hobby plans; that is why email goes out over HTTPS (Gmail API).

## Google sign-in and Gmail sending

1. In console.cloud.google.com, create a project and enable the **Gmail API**.
2. OAuth consent screen: External, add donryscott28@gmail.com as a test user. Before you go live, click "Publish app": in Testing mode, refresh tokens can expire after 7 days.
3. Credentials > Create OAuth client ID > Web application. Authorized redirect URIs:
   `https://YOUR-DOMAIN/auth/google/callback` and `https://developers.google.com/oauthplayground`
4. Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Get the refresh token: open developers.google.com/oauthplayground, click the gear, tick "Use your own OAuth credentials", paste the ID and secret. In step 1 enter the scope `https://www.googleapis.com/auth/gmail.send`, authorize with donryscott28@gmail.com, click "Exchange authorization code for tokens", and copy the refresh token into `GOOGLE_REFRESH_TOKEN`.
6. Set `EMAIL_FROM=donryscott28@gmail.com`.

Each part turns on only when its variables are set. No Google variables means no Google button, and email falls back to Resend, Brevo, SMTP, or the console.

## AI assistant

Set one of these in Variables:

- `GROQ_API_KEY` from console.groq.com (default model `llama-3.3-70b-versatile`)
- `ANTHROPIC_API_KEY` from console.anthropic.com (default model `claude-haiku-4-5-20251001`)

Optional: `AI_MODEL` to pick a different model. Only logged-in members see the "Ask AI" button, each is limited to 20 questions per 10 minutes, and the assistant knows the titles of your pages.

## Uploading pages

Each upload opens full-screen exactly as you designed it, for members and visitors alike (members-only pages ask for login first). The site adds only a small "Studies Hub" back button and, if your file has none, a mobile viewport tag.
Best results: one self-contained file, with CSS, JavaScript and images inside it or loaded from full https:// links. Files that point to other uploaded files (like `style.css` or `about.html`) will not find them. Limit: 5 MB per file.

## Other email options

`RESEND_API_KEY` + `MAIL_FROM` (needs a domain you own), `BREVO_API_KEY` + `MAIL_FROM`, or SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) on hosts that allow it.

Uploaded pages run on the same domain as the site, so only upload HTML you trust.

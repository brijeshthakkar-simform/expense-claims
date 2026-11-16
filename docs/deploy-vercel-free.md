# Deploy for free: Vercel Hobby + Neon Free + Tigris

This guide puts the app on the internet at no cost, for a demo with fake data. You do the account
steps by hand; one script on your laptop does the database, the migrations, the demo data and the
settings file. Allow 45 to 60 minutes the first time.

What you end up with: the app on `https://<your-project>.vercel.app`, a PostgreSQL 18 database on
Neon, receipts in a Tigris bucket, nine demo users (`asha.rao@acme.test` and others), no real data.

Facts that are checked against a source carry a link. Anything I could not confirm is marked
**unconfirmed**. Figures were read from the linked pages on 2026-11-16, so check them again before you
rely on one.

## 0. Read this first

- **Vercel Hobby is for personal, non-commercial use.** Vercel's terms say you "shall only use the
  Services under a Hobby plan for your personal or non-commercial use"
  ([terms](https://vercel.com/legal/terms), last updated October 19, 2026). Whether a company demo
  counts is a judgement about those terms, not something I can settle. If in doubt, ask.
- **Receipts are capped at 4 MiB on this hosted copy.** Vercel rejects any request body over 4.5 MB
  ([limits](https://vercel.com/docs/functions/limitations)), so the Vercel build lowers the cap from
  10 MiB to 4 MiB. The local Docker stack still takes 10 MiB.
- **Never use "Add integration" or a Marketplace database.** The Neon integration for Vercel puts the
  database owner's credentials into your project. This app refuses to start when it holds them. You
  create Neon by hand, below.
- **Next.js 16.4.0 is flagged by an advisory check.** When this repository's `next build` was run from
  an AI coding agent session on a laptop, it stopped once with a `SecurityFatalError` that says the
  installed Next.js version is affected by a known security vulnerability, and the next run continued
  with a warning. The check is in Next.js's own code (`node_modules/next/dist/lib/upgrade/nudge.js`)
  and reads the npm advisory feed. Whether Vercel's own build behaves the same is **unconfirmed**.
  Upgrading Next.js is a code change outside this guide; decide about it before you put anything real
  behind this app.

## 1. On your laptop, once

1. Install Node 24 and pnpm 10.34.6, as the [README](../README.md#prerequisites) says (`nvm install &&
nvm use`, `corepack enable`).
2. In the repository folder run `pnpm install --frozen-lockfile`.
3. Push the repository to **your own** GitHub account (a personal account, and you must be the owner of
   the repository; [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github) says only the
   owner can import it). The branch you deploy is `main`.
4. You do not need Docker for any step in this guide. The repository's `.env` is never used for the
   hosted database: the script sets every value itself.

## 2. Create the three free accounts

### 2.1 Neon (the database)

1. Sign up at <https://neon.com> and create a project. Name it `expense-claims`.
2. Choose **Postgres 18** and the region **AWS Asia Pacific (Singapore)**, `aws-ap-southeast-1`.
   The app needs PostgreSQL 18, because its tables use the built-in `uuidv7()` function. Neon lists
   Postgres 14 to 18 ([versions](https://neon.com/docs/postgresql/postgres-version-support)) and
   Singapore, but no Mumbai ([regions](https://neon.com/docs/introduction/regions), last updated
   2026-10-14). The exact label in the Neon console is **unconfirmed**; the code is `aws-ap-southeast-1`.
3. Do not click anything that says Vercel. Create the project from the Neon website only.
4. On the project dashboard click **Connect**. Pick the role `neondb_owner` and the database
   `neondb`, and **turn pooling off**, so the host has no `-pooler` in it. Show and copy the whole
   connection string. It looks like `postgresql://neondb_owner:...@ep-...ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.
   If you copy the pooled string by mistake, the script switches it to the direct host for you.

Keep that string private. It is the **admin** string. The script uses it once, to create two limited
roles (`expense_owner` for migrations, `expense_app` for the running app); the app never sees it.

### 2.2 Tigris (the receipt bucket)

1. Sign up at <https://www.tigrisdata.com> and open the dashboard.
2. Create a bucket ([docs](https://www.tigrisdata.com/docs/buckets/create-bucket/)). Bucket names are
   global, so pick something unlikely to be taken, such as `expense-claims-receipts-<your-initials>`.
   Buckets are private by default.
3. Create an access key ([docs](https://www.tigrisdata.com/docs/iam/manage-access-key/)). Choose the
   **Editor** role for your one bucket, so the key reaches only that bucket. The secret is shown
   once, so copy it now. Turning off "Default allowed operations" restricts the key further.
   Whether a key that tight can still run the bucket check the app makes (HeadBucket) is
   **unconfirmed**; if the script's bucket step says 403, create a second key with default access and
   use that one for the first run only.
4. Write down four values: endpoint `https://t3.storage.dev`, region `auto`
   ([Tigris JavaScript SDK page](https://www.tigrisdata.com/docs/sdks/s3/aws-js-sdk/)), the bucket
   name, and the key id and secret.

**Unconfirmed, and the one real risk here:** Tigris's own examples switch path-style addressing
**off**, and its docs do not say whether path-style requests work. This app always uses path-style.
The script's bucket step (step 4 of 8) is exactly the test. If it fails against Tigris, use the
fallback below, and nothing else in this guide changes.

Free allowance, as the [pricing page](https://tigrisdata.com/pricing.md) states it (the page has no
date): 5 GB of storage, 10,000 Class A requests, 100,000 Class B requests a month, no charge for
data out, and "No credit card required to get started".

**Fallback: Cloudflare R2.** Endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region
`auto` ([S3 API](https://developers.cloudflare.com/r2/api/s3/api/)). Create the bucket in the
Cloudflare dashboard, then an Object Read and Write token limited to it
([tokens](https://developers.cloudflare.com/r2/api/tokens/)). The free tier is 10 GB-month, 1 million
Class A and 10 million Class B requests, with free egress
([pricing](https://developers.cloudflare.com/r2/pricing/), updated Oct 30, 2026). **Cloudflare may ask
you to add a card to turn R2 on**; that page does not say either way, so it is **unconfirmed**. Whether
a bucket-limited token passes the bucket check is also **unconfirmed**. If it answers 403, run the
script once with an Admin token, then put the limited token into Vercel.

### 2.3 Vercel (the web host)

Sign up at <https://vercel.com> with your GitHub account and stay on the **Hobby** plan. Do not enter
a card. You import the project in step 4.

## 3. Run the setup script

In the repository folder, in a terminal where `nvm use` has selected Node 24:

```bash
bash scripts/deploy/hosted-setup.sh
```

It asks for six things. The two marked hidden do not echo as you paste them:

| Prompt                        | Paste                                                    |
| ----------------------------- | -------------------------------------------------------- |
| Admin connection string       | the Neon string from 2.1 (hidden)                        |
| S3 endpoint                   | `https://t3.storage.dev`                                 |
| S3 region                     | `auto`                                                   |
| Bucket name                   | your bucket                                              |
| S3 access key id              | the key id                                               |
| S3 secret access key          | the secret (hidden)                                      |

It then runs eight steps, announcing each: checks, database roles (it asks "Set up THIS database?"
and shows the Neon host first), the migration question, the bucket check, the migrations, the demo
data, a check as the limited runtime role, and the settings file. Each step stops loudly if it
fails. It is safe to run again: a rerun reuses the passwords, skips what is done, and applies only
what is missing.

What it writes, both readable by you only (mode 600):

- `~/.expense-claims-hosting.env`: three passwords it generated (`OWNER_PW`, `APP_PW`, `DEMO_PW`).
  Keep this file. The demo users hold `DEMO_PW`, so deleting it without a fresh database breaks login.
- `~/expense-claims-vercel-env.txt`: the variables to paste into Vercel.

It prints only file paths, variable names and the demo login emails, never a password or a full
connection string. The seed refuses `APP_ENV=staging` on purpose; the script runs it on your laptop
as `local`, while the Vercel app is labelled `staging` and holds only fake data.

## 4. Import the project into Vercel

1. In Vercel: **Add New**, **Project**, **Import Git Repository**. Install the GitHub app when asked
   and give it **only the one repository**. Pick the repository.
2. Leave **Framework Preset** as Next.js and **Root Directory** as `./`. Leave the build command alone:
   `vercel.json` already sets `pnpm db:generate && pnpm build` and pins the function region to `sin1`
   (Singapore, next to the database).
3. Open **Environment Variables**. Open `~/expense-claims-vercel-env.txt`, copy everything, and paste it
   into the **Key** field of the form. Vercel creates one variable per line
   ([docs](https://vercel.com/docs/environment-variables), "Add variables in bulk"). Tick **Production
   only** (untick Preview and Development). Mark `DATABASE_URL` and `S3_SECRET_ACCESS_KEY` as **Secret**
   if the form offers it; a Secret cannot be read back, and you still have the file.
4. Check the list holds exactly these names: `APP_ENV`, `APP_BASE_URL`, `DATABASE_URL`,
   `DB_POOL_MAX`, `RECEIPT_STORAGE_DRIVER`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `ENABLE_EXPERIMENTAL_COREPACK`. Add nothing else.
   In particular never add `MIGRATE_DATABASE_URL`, anything starting with `SEED_`, or any password:
   the app exits at start-up if it finds them.
5. `ENABLE_EXPERIMENTAL_COREPACK=1` makes Vercel use the pinned pnpm 10.34.6; without it Vercel picks
   "pnpm 9 or 10" for this lockfile ([package managers](https://vercel.com/docs/package-managers),
   [build configuration](https://vercel.com/docs/builds/configure-a-build)). Whether Corepack honours
   the pin on Vercel is **unconfirmed**: look for `pnpm 10.34.6` in the install log.
6. Set **Node.js Version** to 24.x (project **Settings**, **Build and Deployment**), if it is not
   already. `package.json` also asks for `24.x`. Check `node -v` in the build log; the app uses
   `crypto.argon2`, which needs Node 24.7 or newer
   ([Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions),
   [Node 24.7.0](https://nodejs.org/en/blog/release/v24.7.0)).
7. Keep **Production Branch** as `main`.

## 5. First deploy, then fix `APP_BASE_URL`

1. Press **Deploy** and wait for the build. Leave `APP_BASE_URL` as the placeholder for this first run.
   The app starts with it, but sign-in will fail until step 3 below.
2. When it finishes, copy the production address Vercel shows, for example
   `https://expense-claims-abc.vercel.app`. It is `https://`, with no slash at the end.
3. Open **Settings**, **Environment Variables**, edit `APP_BASE_URL` and set it to exactly that
   address. The app compares the browser's `Origin` with this value character for character, and uses
   it to name the session cookie.
4. **Redeploy**: Deployments, the three dots on the latest one, **Redeploy**. A changed variable
   reaches only new deployments ([docs](https://vercel.com/docs/environment-variables)).

(Shortcut: you may instead set `APP_BASE_URL` to `https://<project-name>.vercel.app` before the first
deploy, using the project name from the import screen, and just confirm it matches afterwards.)

## 6. Check that it works

1. Open `https://<your-address>/api/health/ready` in a browser. Expect
   `{"data":{"status":"ready","checks":{"db":"ok","integrityTriggers":"ok","storage":"ok"}}}`.
2. Find the demo password: run `grep DEMO_PW ~/.expense-claims-hosting.env` (the value is after the `=`).
3. Open the app and sign in as `asha.rao@acme.test` with that password.
4. Follow the click path in [demo-script.md](demo-script.md): create a claim, submit it, approve it
   as `ravi.menon@acme.test`, and export as `farah.khan@acme.test`.
5. Attach a receipt under 4 MiB to a line. A bigger one is refused on purpose (see section 9).

## 7. Lock it down

1. **Rate-limit sign-in.** The app has no login throttling of its own, so add one free rule. In
   Vercel open the project, **Firewall**, **Configure**, **+ New Rule**. Name it `login`. Add two
   conditions: Request Path equals `/api/v1/auth/login`, and Request Method equals `POST`. For
   **Then** pick **Rate Limit**, strategy **Fixed Window**, time window 60 seconds, request limit 10,
   key **IP**, and keep the default action 429. **Save Rule**, then **Review Changes** and **Publish**
   ([WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting), updated
   2026-08-28). Hobby allows one such rule per project, and counters are kept per region.
2. **Choose who can open the site.** On Hobby you have two free choices
   ([Hobby plan](https://vercel.com/docs/plans/hobby),
   [Deployment Protection](https://vercel.com/docs/deployment-protection)):
   - **Public production address (the default).** Anyone with the link sees the sign-in page. The data
     is fake and the demo password is 48 random hex characters. This is the easy choice for showing a
     manager.
   - **Vercel Authentication on All Deployments** (Settings, Deployment Protection). Everyone, you
     included, must sign in to Vercel first. The number of outside people Hobby lets in is
     **unconfirmed**; one page says one external user and one shareable link.
   **Password Protection is a paid Pro feature ($20 a month per project): do not turn it on.**
3. **Previews.** A preview deployment gets a different address, and the app only accepts the one in
   `APP_BASE_URL`, so sign-in could never work there. You gave the variables to Production only, so a
   preview cannot even start. Leave it like that. (Vercel also puts previews behind Vercel
   Authentication by default, per the
   [lock-down guide](https://vercel.com/kb/guide/locking-down-deployments).) If you want Vercel to
   stop building previews at all, ask the assistant to add `git.deploymentEnabled` to `vercel.json`
   ([docs](https://vercel.com/docs/project-configuration/git-configuration)); that is not done for
   you.

## 8. Update the app later

1. If the change adds a migration, run `bash scripts/deploy/hosted-setup.sh` **first**, with the same
   Neon string and storage values. It applies only the new migrations; the demo users stay.
2. Then `git push` to `main`. Vercel builds and deploys by itself.

A rerun rewrites `~/expense-claims-vercel-env.txt` with the same values, so you only paste it again
if you changed storage or database. Never run `pnpm db:reset` or `prisma migrate reset` against the
hosted database.

## 9. Reset the hosted demo

The demo data is seeded once; there is no reset script. To start clean:

1. In the Neon console delete the database `neondb` and add a new `neondb` owned by `neondb_owner`
   (or create a new Neon project and copy its new admin string).
2. If you made a **new project**, also delete `~/.expense-claims-hosting.env` and
   `~/expense-claims-vercel-env.txt`, because new roles need new passwords, and update `DATABASE_URL` in
   Vercel from the new file. If you only recreated the database, keep both files.
3. Run `bash scripts/deploy/hosted-setup.sh` again, then redeploy in Vercel if any variable changed.
4. Optionally empty the Tigris bucket in its dashboard; old receipts belong to deleted claims.

## 10. When something goes wrong

Open the failing deployment in Vercel and read **Logs**, **Runtime Logs** (Hobby keeps one hour,
[Hobby plan](https://vercel.com/docs/plans/hobby)). Paste the last 30 lines, without any value after
an `=`, to the assistant.

| What you see | Why | What to do |
| ------------ | --- | ---------- |
| Build fails with `ENOENT ... next-server.js.nft.json` | A known Next.js 16 problem when `output: 'standalone'` is set on Vercel ([issue](https://github.com/vercel/next.js/issues/96646)). `next.config.ts` already turns standalone off on Vercel. | Should not happen. Paste the end of the build log to the assistant. |
| Build stops with `Your version of Next.js is affected by a known security vulnerability` | The Next.js advisory check, see section 0. | Run the build again; if it still stops, paste the log to the assistant. Upgrading is a separate decision. |
| Runtime log says `Invalid environment configuration` | A variable is missing or malformed. The message names the variable and never its value. | Fix it in Settings, Environment Variables, then redeploy. |
| Runtime log says `Refusing to boot, forbidden variables set: ...` | A forbidden variable is in the project, often from a Vercel integration. | Delete that variable (and any Neon integration), then redeploy. |
| Runtime log says `Refusing to boot, the database role is not least-privilege` | `DATABASE_URL` is not the `expense_app` role. | Copy the `DATABASE_URL` line from `~/expense-claims-vercel-env.txt` again, then redeploy. |
| `/api/health/ready` returns 503 with `storage` down | Wrong S3 endpoint, key or bucket, or the store does not accept path-style requests (unconfirmed for Tigris). | Re-check the values; try the R2 fallback in 2.2. |
| Receipt upload fails with 413 for a file over 4 MiB | By design. Vercel refuses request bodies over 4.5 MB. | Use a smaller file. |
| The first page after a quiet spell is slow | Neon Free scales to zero after 5 minutes and wakes on the next request ([plans](https://neon.com/docs/introduction/plans)). | Wait a few seconds and reload. |
| Sign-in answers 403 `CSRF_REJECTED` | `APP_BASE_URL` is not the address in your browser (check `https`, the spelling and no slash at the end). | Fix `APP_BASE_URL`, redeploy (section 5). |
| The script says it is a local database | You pasted a localhost string. | Paste the Neon string. |
| The script cannot make `expense_owner` own the database | Neon may not allow that statement (unconfirmed). | In the Neon console create a database owned by `expense_owner` (the script already made that role), put its name in the admin string, run the script again. |
| The script says a role has CREATEDB or similar | A role of that name was made earlier by hand. | Delete `expense_owner` and `expense_app` in Neon (not in SQL by hand), then run again. |
| The script's bucket step fails | Wrong endpoint or key, a bucket name someone else owns, or a key that may not create buckets. | Create the bucket in the dashboard and run again. |

## 11. Free-tier facts and sources

| Service | Free allowance | Source |
| ------- | -------------- | ------ |
| Neon Free | $0; 100 CU-hours per project per month; 1 GB storage per project (20 GB per account); up to 2 CU; scales to zero after 5 minutes, which cannot be turned off; 5 GB public transfer per project per month; 6 hours of restore history | [plans](https://neon.com/docs/introduction/plans) (last updated 2026-11-12) |
| Vercel Hobby | Free; personal and non-commercial use only; 100 deployments a day; 300 s function limit; 4 CPU-hours and 360 GB-hours of function use; 1,000,000 invocations; 100 GB Fast Data Transfer; past a limit you wait 30 days | [Hobby plan](https://vercel.com/docs/plans/hobby) (2026-11-12), [terms](https://vercel.com/legal/terms) |
| Vercel request body | 4.5 MB maximum, then 413 | [limits](https://vercel.com/docs/functions/limitations) (2026-08-24) |
| Vercel WAF rate limit | 1 rule per project on Hobby, 1,000,000 allowed requests included | [rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) (2026-08-28) |
| Tigris | 5 GB, 10,000 Class A, 100,000 Class B a month, free egress, no card | [pricing](https://tigrisdata.com/pricing.md) (undated) |
| Cloudflare R2 (fallback) | 10 GB-month, 1 million Class A, 10 million Class B, free egress; card requirement unconfirmed | [pricing](https://developers.cloudflare.com/r2/pricing/) (2026-10-30) |

## 12. Never switch these on

Each of these can start a charge or break the app:

- A **custom domain**. The app accepts one address only, and the free address is enough.
- **Vercel Pro** or a Pro trial, **Password Protection** ($20 a month per project) and **Static IPs**
  (Pro and above, listed at $100 a month per project in [Vercel's docs](https://vercel.com/docs/networking/static-ips)).
- Any **paid Neon plan**, or raising Neon limits.
- **AWS** for storage or the database: a new account's credits expire and it needs a card.
- Any **Vercel Marketplace integration** (it injects credentials this app refuses).

## 13. What no one has tested yet

The script was rehearsed against a local PostgreSQL 18 and the local SeaweedFS store, not against Neon,
Tigris or Vercel. These still depend on the real services: Neon's behaviour on the ownership and
grant statements, Tigris and R2 with path-style requests and limited keys, the pooled Neon address with
this app, Vercel's build (Node 24, Corepack, the Next.js advisory check) and the firewall rule.

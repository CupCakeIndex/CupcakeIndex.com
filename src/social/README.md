# Daily X posts

Every day (August through January) a GitHub Action makes one graphic from the site's
data and, **only if you turn it on**, posts it to the Cupcake Index X account.

| Day | Post |
|-----|------|
| Mon | CFB power rankings top 10 + biggest movers |
| Tue | NFL power rankings top 10 + biggest movers |
| Wed | Most padded résumés: Cupcake score for the CFB top 25 |
| Thu | Cupcake Bully of the Week (CFB + NFL) |
| Fri | Rest day (nothing posts) |
| Sat | CFB game day: the week's biggest games with win odds |
| Sun | NFL game day: the slate with win odds |

Files:
- `render.py` makes the picture (`out/social/<day>.png`) and tweet text (`<day>.txt`). It never talks to X.
- `post_to_x.py` posts it. It does nothing unless posting is switched on (below).
- `.github/workflows/social.yml` runs both every day at 15:00 UTC (11am Eastern).
- `fonts/` is JetBrains Mono (free font, license in `fonts/OFL.txt`). `assets/logo-mark.png` is the cupcake from `branding/logo-mark.svg`.

Right now it runs in **dry-run mode**: it makes the graphic and saves it on the run's page
(Actions tab, click a "Daily X post" run, scroll to **Artifacts**, download `social-post`).
Nothing is posted until you finish the steps below.

## Try it on your computer

```
pip install -r src/social/requirements.txt
python src/social/render.py --all --out branding/samples/social
```

That makes all 7 days' pictures so you can look at them. `--day fri` makes just one.

## What the X API costs (checked October 2026)

X no longer has a free tier for new developers. It's pay-as-you-go: you buy credits up front
in the developer console and each call uses some.

- A post: **$0.015**. A post **with a link** in it: **$0.20**.
- Daily posting, about 30 posts a month: roughly **$6/month with the link**, or **about $0.50/month without it**.
- Limits are not a problem: 100 posts per 15 minutes per user, 10,000 per day per app.

Sources: [X API pricing](https://docs.x.com/x-api/getting-started/pricing),
[X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits). Prices change; the
console shows the current ones.

Posts go out WITHOUT a link to the site (the picture already says cupcakeindex.com, and your
profile links to the site). That keeps each post at the cheaper plain-post price. To add the link
back, set a repo **variable** `X_INCLUDE_LINK` = `true` (same place as step 4 below).

## Turn it on (one time, about 15 minutes)

1. **Make a developer account.** Sign in to X as the Cupcake Index account, then go to
   <https://console.x.com>. Accept the developer agreement.
2. **Buy a few dollars of credits** in the console (Billing). Set a monthly **spending limit**
   too (e.g. $10) so nothing can surprise you.
3. **Create an app** in the console, then get its keys:
   - In the app's settings, set **User authentication / App permissions** to **Read and Write**.
     (Do this *before* step 3b. Tokens made while it was "Read" can't post.)
   - Under **Keys and tokens**, copy the **API Key** and **API Key Secret**.
   - Also under Keys and tokens, generate the **Access Token** and **Access Token Secret**.
     They should say they were created with Read and Write.
   - X only shows each secret once. Paste them straight into step 4 (or a password manager).
4. **Add them to GitHub.** Open the repo on github.com: **Settings > Secrets and variables > Actions**.
   On the **Secrets** tab, click **New repository secret** four times:

   | Name | Value |
   |------|-------|
   | `X_API_KEY` | API Key |
   | `X_API_SECRET` | API Key Secret |
   | `X_ACCESS_TOKEN` | Access Token |
   | `X_ACCESS_SECRET` | Access Token Secret |

   Never put these in a file in the repo.
5. **Test without posting.** Actions tab > **Daily X post** > **Run workflow**. When it finishes,
   download the `social-post` artifact and check the picture and text.
6. **Flip the switch.** Same Settings page, **Variables** tab > **New repository variable**:
   name `X_POSTING_ENABLED`, value `true`. Run the workflow once more by hand. The log's last
   step prints the link to the new post.

**To stop posting:** change `X_POSTING_ENABLED` to `false` (or delete it). Nothing else needed.

## Good to know

- It won't post old news: if the site's rankings are more than 10 days old (offseason, or the
  weekly update broke), the day is skipped. Same if there are no games/lines to show.
- The Sunday NFL card covers the whole week's slate, so it can include the Thursday game.
- If a post fails, the run turns red and the log shows X's error message. The usual causes are
  no credits left, or the access token was made before the app had Read and Write permission
  (regenerate it and update `X_ACCESS_TOKEN` and `X_ACCESS_SECRET`).
- Posting uses the X API v2 (`/2/media/upload` then `/2/tweets`). The old v1.1 upload that many
  tutorials show was shut off in 2025.

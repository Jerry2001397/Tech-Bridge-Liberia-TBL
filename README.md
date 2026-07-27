# Tech-Solution.com

## Booking Database and Admin

This site now includes a Node server that:

- serves the static website
- stores home page booking form submissions in PostgreSQL
- provides an admin login at `/admin` to review booking requests
- can email booking notifications when SendGrid variables are configured

### Render Setup

Deploy with Render using the root [render.yaml](render.yaml). It provisions:

- a Node web service
- a PostgreSQL database
- the required environment variables for the application

Set or confirm these environment values in Render:

- `ADMIN_USERNAME`: admin login username
- `ADMIN_PASSWORD`: admin login password
- `SESSION_SECRET`: generated session signing secret
- `DATABASE_URL`: supplied from the Render PostgreSQL database
- `DATABASE_SSL`: keep `false` for the Render internal database URL unless you switch to an SSL-required external connection
- `SENDGRID_API_KEY`: SendGrid API key for booking notifications
- `SENDGRID_SENDER`: verified sender email address in SendGrid
- `NOTIFY_EMAIL`: inbox that should receive new booking request alerts
- `SUPABASE_URL`: your Supabase project URL for CDN-backed news image storage
- `SUPABASE_SERVICE_ROLE_KEY`: service role key used by the server to upload and delete news images
- `SUPABASE_STORAGE_BUCKET`: public Supabase Storage bucket name for news images, default `news-images`

### News Image CDN Storage

News article images can now be stored in a Supabase Storage bucket instead of the local Render filesystem. This is the recommended production setup because Supabase serves public bucket assets through its CDN and the files persist across deploys.

To enable it:

1. Create a public bucket in Supabase Storage, for example `news-images`.
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the Render web service.
3. Set `SUPABASE_STORAGE_BUCKET` if you use a bucket name other than `news-images`.

When these variables are configured, the admin news form uploads article images to Supabase Storage automatically. If they are not configured, the server falls back to the existing local `/uploads/news` storage for development.

### Supabase And Render Setup

Use these exact values unless you already chose a different bucket name:

- Supabase bucket name: `news-images`
- Render variable key: `SUPABASE_STORAGE_BUCKET`
- Render variable value: `news-images`

Step by step:

1. Open your Supabase project dashboard.
2. Go to Storage.
3. Create a new bucket named `news-images`.
4. Turn on the Public bucket option so uploaded images can be served from the CDN.
5. Open Supabase Project Settings, then API.
6. Copy Project URL and set it in Render as `SUPABASE_URL`.
7. Copy the service role key and set it in Render as `SUPABASE_SERVICE_ROLE_KEY`.
8. In Render, add `SUPABASE_STORAGE_BUCKET` with value `news-images`.
9. Redeploy the Render service.
10. Open `/admin`, create a news post, and confirm the image URL starts with your Supabase domain instead of `/uploads/news/`.

Example `SUPABASE_URL` format:

- `https://YOUR_PROJECT_REF.supabase.co`

### Admin Access

After deployment, open `/admin` on the deployed site and sign in with the admin credentials you configured in Render.

### Backend Routes

After deployment, your backend routes will be served from the same Render service domain:

- `/api/bookings`: receives booking form submissions
- `/admin`: admin login and request dashboard
- `/api/news`: returns published news items, including their CDN image URLs when Supabase Storage is enabled

If your Render URL is `https://tech-solution-site.onrender.com`, then the full links are:

- `https://tech-solution-site.onrender.com/api/bookings`
- `https://tech-solution-site.onrender.com/admin`
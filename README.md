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

### Admin Access

After deployment, open `/admin` on the deployed site and sign in with the admin credentials you configured in Render.

### Backend Routes

After deployment, your backend routes will be served from the same Render service domain:

- `/api/bookings`: receives booking form submissions
- `/admin`: admin login and request dashboard

If your Render URL is `https://tech-solution-site.onrender.com`, then the full links are:

- `https://tech-solution-site.onrender.com/api/bookings`
- `https://tech-solution-site.onrender.com/admin`
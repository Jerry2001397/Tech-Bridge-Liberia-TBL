// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const apiKey = Deno.env.get("SENDGRID_API_KEY") ?? "";
  const senderEmail = Deno.env.get("SENDGRID_SENDER") ?? "";
  const notifyEmail = Deno.env.get("NOTIFY_EMAIL") ?? "";

  if (!apiKey || !senderEmail || !notifyEmail) {
    return new Response(JSON.stringify({ error: "Missing SendGrid configuration" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const body = await req.json();
  const fullName = body.full_name ?? "";
  const email = body.email ?? "";
  const phone = body.phone ?? "";
  const serviceType = body.service_type ?? "";
  const preferredServiceDate = body.preferred_service_date ?? "";
  const paymentMethod = body.payment_method ?? "";
  const address = body.address ?? "";

  const message = {
    personalizations: [
      {
        to: [{ email: notifyEmail }],
        subject: "New Booking Request"
      }
    ],
    from: { email: senderEmail, name: "Tech Bridge Liberia Notifications" },
    content: [
      {
        type: "text/plain",
        value:
          `New booking request:\n` +
          `Name: ${fullName}\n` +
          `Email: ${email}\n` +
          `Phone: ${phone}\n` +
          `Service: ${serviceType}\n` +
          `Preferred date: ${preferredServiceDate}\n` +
          `Payment method: ${paymentMethod}\n` +
          `Address: ${address}\n`
      }
    ]
  };

  const sendResponse = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });

  if (!sendResponse.ok) {
    const errorText = await sendResponse.text();
    return new Response(JSON.stringify({ error: "SendGrid error", detail: errorText }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});

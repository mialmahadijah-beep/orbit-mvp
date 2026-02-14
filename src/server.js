require("dotenv").config();

const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const nodemailer = require("nodemailer");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const app = express();

// -------------------- Config --------------------
const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "admin").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "1234").trim();

const YOUR_NOTIFY_EMAIL = (process.env.YOUR_NOTIFY_EMAIL || "").trim();

const PLAN_DAYS = parseInt(process.env.PLAN_DAYS || "30", 10);
const REMIND_DAYS_BEFORE = parseInt(process.env.REMIND_DAYS_BEFORE || "3", 10);

// Optional base url for printing links on admin UI
const BASE_URL = (process.env.BASE_URL || "").trim();

// -------------------- Middleware --------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "orbit-secret-change-me",
    resave: false,
    saveUninitialized: false,
  })
);

// -------------------- Helpers --------------------
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getDaysLeft(dueAt) {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function bankDetailsHtml() {
  const name = process.env.BANK_ACCOUNT_NAME || "";
  const bank = process.env.BANK_NAME || "";
  const acc = process.env.BANK_ACCOUNT_NUMBER || "";
  const cur = process.env.BANK_CURRENCY || "";
  const note = process.env.BANK_PAYMENT_NOTE || "";

  // If user hasn't filled bank details, return a simple message (won't crash)
  if (!name && !bank && !acc) {
    return `<p><b>Payment details will be provided after request.</b></p>`;
  }

  return `
    <p><b>Bank Transfer Details</b></p>
    <ul>
      <li><b>Account Name:</b> ${name}</li>
      <li><b>Bank Name:</b> ${bank}</li>
      <li><b>Account Number:</b> ${acc}</li>
      <li><b>Currency:</b> ${cur}</li>
    </ul>
    <p>${note}</p>
  `;
}

function smtpReady() {
  return (
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

/**
 * IMPORTANT: This email sender will NEVER crash your app.
 * If SMTP is missing/wrong, it logs the error and continues.
 */
async function sendEmail({ to, subject, html }) {
  try {
    if (!smtpReady()) {
      console.log("⚠️ EMAIL NOT CONFIGURED. Would send:", { to, subject });
      return { ok: false };
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
    });

    return { ok: true };
  } catch (err) {
    console.log("❌ Email send failed:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/login");
}

// -------------------- Subscription Checker --------------------
async function subscriptionCheck() {
  const clients = await prisma.client.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
  });

  for (const c of clients) {
    if (!c.dueAt) continue;

    const left = getDaysLeft(c.dueAt);

    // Reminder
    if (c.status === "ACTIVE" && left !== null && left <= REMIND_DAYS_BEFORE && left > 0) {
      const already =
        c.lastReminderAt &&
        Date.now() - new Date(c.lastReminderAt).getTime() < 24 * 60 * 60 * 1000;

      if (!already) {
        await prisma.client.update({
          where: { id: c.id },
          data: { lastReminderAt: new Date() },
        });

        await sendEmail({
          to: c.email,
          subject: `Payment Reminder: ${left} day(s) left`,
          html: `
            <p>Hello ${c.name},</p>
            <p>Your Orbit plan will expire in <b>${left} day(s)</b>.</p>
            <p>Please pay to avoid account pause.</p>
            ${bankDetailsHtml()}
          `,
        });
      }
    }

    // Expired -> Auto Pause
    if (c.status === "ACTIVE" && left !== null && left <= 0) {
      await prisma.client.update({
        where: { id: c.id },
        data: { status: "PAUSED", pausedAt: new Date(), pauseReason: "expired" },
      });

      await sendEmail({
        to: c.email,
        subject: `Account Paused: Payment Required`,
        html: `
          <p>Hello ${c.name},</p>
          <p>Your account has been <b>PAUSED</b> because your subscription ended.</p>
          <p>Pay now to reactivate.</p>
          ${bankDetailsHtml()}
        `,
      });

      if (YOUR_NOTIFY_EMAIL) {
        await sendEmail({
          to: YOUR_NOTIFY_EMAIL,
          subject: `Client Auto-Paused: ${c.name} (${c.code})`,
          html: `<p>Client <b>${c.name}</b> was auto-paused due to expiry.</p>`,
        });
      }
    }
  }
}

// Run checker every 1 hour (and also whenever admin opens dashboard)
setInterval(() => {
  subscriptionCheck().catch((e) => console.log("subscriptionCheck error:", e.message));
}, 60 * 60 * 1000);

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.send("OK ✅ Orbit MVP running");
});

// Login
app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const username = (req.body.username || "").trim();
  const password = (req.body.password || "").trim();

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }

  return res.render("login", { error: "Wrong login details" });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Admin dashboard
app.get("/admin", requireAdmin, async (req, res) => {
  await subscriptionCheck().catch(() => {});

  const clients = await prisma.client.findMany({ orderBy: { createdAt: "desc" } });
  const leads = await prisma.lead.findMany({
    take: 50,
    orderBy: { createdAt: "desc" },
    include: { client: true },
  });
  const intake = await prisma.intakeRequest.findMany({
    take: 50,
    orderBy: { createdAt: "desc" },
  });

  const clientsWithMeta = clients.map((c) => ({
    ...c,
    daysLeft: c.dueAt ? getDaysLeft(c.dueAt) : null,
    dueDate: c.dueAt ? new Date(c.dueAt).toISOString().slice(0, 10) : "",
    leadForm: BASE_URL ? `${BASE_URL}/c/${c.code}` : `/c/${c.code}`,
  }));

  res.render("admin/dashboard", { clients: clientsWithMeta, leads, intake });
});

// Add Client (manual)
app.post("/admin/clients/add", requireAdmin, async (req, res) => {
  const name = (req.body.name || "").trim();
  const code = (req.body.code || "").trim();
  const email = (req.body.email || "").trim();
  const bookingLink = (req.body.bookingLink || "").trim();

  const now = new Date();
  const due = addDays(now, PLAN_DAYS);

  await prisma.client.create({
    data: {
      name,
      code,
      email,
      bookingLink: bookingLink || null,
      status: "ACTIVE",
      startedAt: now,
      dueAt: due,
    },
  });

  res.redirect("/admin");
});

// Manual pause -> send payment email
app.post("/admin/clients/:id/pause", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const c = await prisma.client.findUnique({ where: { id } });
  if (!c) return res.redirect("/admin");

  await prisma.client.update({
    where: { id },
    data: { status: "PAUSED", pausedAt: new Date(), pauseReason: "manual" },
  });

  await sendEmail({
    to: c.email,
    subject: "Account Paused: Payment Required",
    html: `
      <p>Hello ${c.name},</p>
      <p>Your account is <b>PAUSED</b>.</p>
      <p>Pay to reactivate:</p>
      ${bankDetailsHtml()}
    `,
  });

  res.redirect("/admin");
});

// Mark paid -> reactivate + reset 30 days
app.post("/admin/clients/:id/paid", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const c = await prisma.client.findUnique({ where: { id } });
  if (!c) return res.redirect("/admin");

  const now = new Date();
  const due = addDays(now, PLAN_DAYS);

  await prisma.client.update({
    where: { id },
    data: { status: "ACTIVE", startedAt: now, dueAt: due, pausedAt: null, pauseReason: null },
  });

  await sendEmail({
    to: c.email,
    subject: "Payment Received: Account Reactivated",
    html: `<p>Hello ${c.name},</p><p>Your account is now <b>ACTIVE</b>. Thank you!</p>`,
  });

  res.redirect("/admin");
});

// Intake
app.get("/intake", (req, res) => {
  res.render("intake", { ok: false });
});

app.post("/intake", async (req, res) => {
  const business = (req.body.business || "").trim();
  const contact = (req.body.contact || "").trim();
  const email = (req.body.email || "").trim();
  const bookingLink = (req.body.bookingLink || "").trim();

  await prisma.intakeRequest.create({
    data: {
      business,
      contact,
      email,
      bookingLink: bookingLink || null,
      status: "NEW",
    },
  });

  if (YOUR_NOTIFY_EMAIL) {
    await sendEmail({
      to: YOUR_NOTIFY_EMAIL,
      subject: `New Intake Request: ${business}`,
      html: `<p><b>${business}</b> submitted intake. Contact: ${contact}. Email: ${email}</p>`,
    });
  }

  res.render("intake", { ok: true });
});

// Approve intake -> create client
app.post("/admin/intake/:id/approve", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const code = (req.body.code || "").trim();

  const ir = await prisma.intakeRequest.findUnique({ where: { id } });
  if (!ir || !code) return res.redirect("/admin");

  const now = new Date();
  const due = addDays(now, PLAN_DAYS);

  await prisma.client.create({
    data: {
      name: ir.business,
      code,
      email: ir.email,
      bookingLink: ir.bookingLink || null,
      status: "ACTIVE",
      startedAt: now,
      dueAt: due,
    },
  });

  await prisma.intakeRequest.update({
    where: { id },
    data: { status: "APPROVED" },
  });

  res.redirect("/admin");
});

// Client lead page
app.get("/c/:code", async (req, res) => {
  const code = req.params.code;
  const client = await prisma.client.findUnique({ where: { code } });
  if (!client) return res.status(404).send("Client not found");

  const paused = client.status !== "ACTIVE";
  res.render("landing", { client, paused });
});

// Lead submit (store lead ALWAYS; email notifications should NEVER crash)
app.post("/c/:code/lead", async (req, res) => {
  const code = req.params.code;
  const client = await prisma.client.findUnique({ where: { code } });
  if (!client) return res.status(404).send("Client not found");

  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim();
  const phone = (req.body.phone || "").trim();
  const message = (req.body.message || "").trim();

  const lead = await prisma.lead.create({
    data: {
      clientId: client.id,
      name,
      email,
      phone: phone || null,
      message: message || null,
    },
  });

  // Notifications (safe)
  if (client.status === "ACTIVE") {
    // Client notification
    await sendEmail({
      to: client.email,
      subject: "New Lead Received ✅",
      html: `
        <p>Hello ${client.name},</p>
        <p>You got a new lead:</p>
        <ul>
          <li><b>Name:</b> ${lead.name}</li>
          <li><b>Email:</b> ${lead.email}</li>
          <li><b>Phone:</b> ${lead.phone || "-"}</li>
          <li><b>Message:</b> ${lead.message || "-"}</li>
        </ul>
      `,
    });

    // Admin notification
    if (YOUR_NOTIFY_EMAIL) {
      await sendEmail({
        to: YOUR_NOTIFY_EMAIL,
        subject: `Client New Lead: ${client.name} (${client.code})`,
        html: `<p>New lead for <b>${client.name}</b>: ${lead.name} - ${lead.email}</p>`,
      });
    }

    // Auto reply to lead with booking link
    if (client.bookingLink) {
      await sendEmail({
        to: lead.email,
        subject: "Thanks — Book Your Call",
        html: `
          <p>Hi ${lead.name},</p>
          <p>Thanks for reaching out to <b>${client.name}</b>.</p>
          <p>Book here:</p>
          <p><a href="${client.bookingLink}">${client.bookingLink}</a></p>
        `,
      });
    }
  }

  // Always show thank you page (no 502)
  res.render("thanks", { client });
});

// -------------------- Start --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Running on port ${PORT}`);
});

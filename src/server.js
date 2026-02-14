require("dotenv").config();

const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const { PrismaClient } = require("@prisma/client");
const nodemailer = require("nodemailer");

const prisma = new PrismaClient();
const app = express();

const PORT = process.env.PORT || 3000;
const PLAN_DAYS = parseInt(process.env.PLAN_DAYS || "30", 10);
const REMIND_DAYS_BEFORE = parseInt(process.env.REMIND_DAYS_BEFORE || "3", 10);

// Views
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session (simple)
app.use(
  session({
    secret: "orbit-secret-change-later",
    resave: false,
    saveUninitialized: false
  })
);

// ---------- Email helper (won't crash if SMTP missing) ----------
function smtpReady() {
  return (
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

async function sendEmail({ to, subject, html }) {
  if (!smtpReady()) {
    console.log("⚠️ EMAIL NOT CONFIGURED (SMTP missing). Would send:", { to, subject });
    return { ok: false };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    html
  });

  return { ok: true };
}

function bankDetailsHtml() {
  return `
    <p><b>Payment Details (Bank Transfer)</b></p>
    <ul>
      <li><b>Account Name:</b> ${process.env.BANK_ACCOUNT_NAME || ""}</li>
      <li><b>Bank Name:</b> ${process.env.BANK_NAME || ""}</li>
      <li><b>Account Number:</b> ${process.env.BANK_ACCOUNT_NUMBER || ""}</li>
      <li><b>Currency:</b> ${process.env.BANK_CURRENCY || ""}</li>
    </ul>
    <p>${process.env.BANK_PAYMENT_NOTE || ""}</p>
  `;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysLeft(dueAt) {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

// ---------- Auth ----------
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/login");
}

// ---------- Subscription checker (auto-pause + reminder) ----------
async function subscriptionCheck() {
  const clients = await prisma.client.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } }
  });

  for (const c of clients) {
    if (!c.dueAt) continue;

    const left = daysLeft(c.dueAt);

    // Reminder
    if (c.status === "ACTIVE" && left !== null && left <= REMIND_DAYS_BEFORE && left > 0) {
      const already = c.lastReminderAt ? (Date.now() - new Date(c.lastReminderAt).getTime()) < (24 * 60 * 60 * 1000) : false;
      if (!already) {
        await prisma.client.update({
          where: { id: c.id },
          data: { lastReminderAt: new Date() }
        });

        await sendEmail({
          to: c.email,
          subject: `Payment Reminder: ${left} day(s) left`,
          html: `
            <p>Hello ${c.name},</p>
            <p>Your Orbit plan will expire in <b>${left} day(s)</b>.</p>
            <p>Please pay to avoid service pause.</p>
            ${bankDetailsHtml()}
          `
        });
      }
    }

    // Expired -> Auto pause + email
    if (c.status === "ACTIVE" && left !== null && left <= 0) {
      await prisma.client.update({
        where: { id: c.id },
        data: { status: "PAUSED", pausedAt: new Date(), pauseReason: "expired" }
      });

      await sendEmail({
        to: c.email,
        subject: `Account Paused: Payment Required`,
        html: `
          <p>Hello ${c.name},</p>
          <p>Your Orbit account has been <b>paused</b> because the subscription period ended.</p>
          <p>Pay now to reactivate.</p>
          ${bankDetailsHtml()}
        `
      });

      if (process.env.YOUR_NOTIFY_EMAIL) {
        await sendEmail({
          to: process.env.YOUR_NOTIFY_EMAIL,
          subject: `Client Auto-Paused: ${c.name} (${c.code})`,
          html: `<p>Client <b>${c.name}</b> was auto-paused due to expiry.</p>`
        });
      }
    }
  }
}

// Run checker every hour
setInterval(() => {
  subscriptionCheck().catch((e) => console.log("subscriptionCheck error:", e.message));
}, 60 * 60 * 1000);

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.send(`OK ✅ Orbit MVP running. Admin: /admin | Intake: /intake | Client pages: /c/CLIENTCODE`);
});

// Login page (admin / 123 etc)
app.get("/login", (req, res) => res.render("login", { error: null }));

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const correct = (username === "admin") && (password === (process.env.ADMIN_PASSWORD || "123"));
  if (!correct) return res.render("login", { error: "Wrong login details" });
  req.session.isAdmin = true;
  res.redirect("/admin");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Admin dashboard
app.get("/admin", requireAdmin, async (req, res) => {
  // Run check on each admin load too
  await subscriptionCheck().catch(() => {});

  const clients = await prisma.client.findMany({ orderBy: { createdAt: "desc" } });
  const leads = await prisma.lead.findMany({
    take: 20,
    orderBy: { createdAt: "desc" },
    include: { client: true }
  });

  const intake = await prisma.intakeRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 20
  });

  res.render("admin/dashboard", {
    clients: clients.map(c => ({
      ...c,
      daysLeft: c.dueAt ? daysLeft(c.dueAt) : null,
      dueDate: c.dueAt ? new Date(c.dueAt).toISOString().slice(0,10) : ""
    })),
    leads,
    intake
  });
});

// Add client (manual)
app.post("/admin/clients/add", requireAdmin, async (req, res) => {
  const { name, code, email, bookingLink } = req.body;

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
      dueAt: due
    }
  });

  res.redirect("/admin");
});

// Pause client (manual) + send payment email
app.post("/admin/clients/:id/pause", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const c = await prisma.client.findUnique({ where: { id } });
  if (!c) return res.redirect("/admin");

  await prisma.client.update({
    where: { id },
    data: { status: "PAUSED", pausedAt: new Date(), pauseReason: "manual" }
  });

  await sendEmail({
    to: c.email,
    subject: `Account Paused: Payment Required`,
    html: `
      <p>Hello ${c.name},</p>
      <p>Your Orbit account has been <b>paused</b>.</p>
      <p>Pay to reactivate.</p>
      ${bankDetailsHtml()}
    `
  });

  res.redirect("/admin");
});

// Mark paid (reactivate + extend 30 days)
app.post("/admin/clients/:id/paid", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const c = await prisma.client.findUnique({ where: { id } });
  if (!c) return res.redirect("/admin");

  const now = new Date();
  const due = addDays(now, PLAN_DAYS);

  await prisma.client.update({
    where: { id },
    data: { status: "ACTIVE", startedAt: now, dueAt: due, pausedAt: null, pauseReason: null }
  });

  await sendEmail({
    to: c.email,
    subject: `Payment Received: Account Reactivated`,
    html: `<p>Hello ${c.name},</p><p>Your Orbit account is now <b>ACTIVE</b>. Thank you!</p>`
  });

  res.redirect("/admin");
});

// Intake form (for NEW clients to request to join)
app.get("/intake", (req, res) => res.render("intake", { ok: false }));

app.post("/intake", async (req, res) => {
  const { business, contact, email, bookingLink } = req.body;

  await prisma.intakeRequest.create({
    data: { business, contact, email, bookingLink: bookingLink || null }
  });

  // notify you (admin)
  if (process.env.YOUR_NOTIFY_EMAIL) {
    await sendEmail({
      to: process.env.YOUR_NOTIFY_EMAIL,
      subject: `New Client Intake Request: ${business}`,
      html: `<p><b>${business}</b> submitted intake. Contact: ${contact}. Email: ${email}</p>`
    });
  }

  res.render("intake", { ok: true });
});

// Approve intake -> create client (admin)
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
      dueAt: due
    }
  });

  await prisma.intakeRequest.update({
    where: { id },
    data: { status: "APPROVED" }
  });

  res.redirect("/admin");
});

// Client public lead form
app.get("/c/:code", async (req, res) => {
  const code = req.params.code;
  const client = await prisma.client.findUnique({ where: { code } });
  if (!client) return res.status(404).send("Client not found");

  // If paused, show paused page but still allow lead capture? (we will block form)
  if (client.status !== "ACTIVE") {
    return res.render("landing", { client, paused: true });
  }

  res.render("landing", { client, paused: false });
});

// Lead submit (stores lead + client notification + auto-reply w/ booking link)
app.post("/c/:code/lead", async (req, res) => {
  const code = req.params.code;
  const client = await prisma.client.findUnique({ where: { code } });
  if (!client) return res.status(404).send("Client not found");

  const { name, email, phone, message } = req.body;

  // Always store lead (even if paused)
  const lead = await prisma.lead.create({
    data: {
      clientId: client.id,
      name,
      email,
      phone: phone || null,
      message: message || null
    }
  });

  // If client is active, notify client + you + auto-reply to lead with booking link
  if (client.status === "ACTIVE") {
    // Notify client
    await sendEmail({
      to: client.email,
      subject: `New Lead Received ✅`,
      html: `
        <p>Hello ${client.name},</p>
        <p>You got a new lead:</p>
        <ul>
          <li><b>Name:</b> ${lead.name}</li>
          <li><b>Email:</b> ${lead.email}</li>
          <li><b>Phone:</b> ${lead.phone || "-"}</li>
          <li><b>Message:</b> ${lead.message || "-"}</li>
        </ul>
      `
    });

    // Notify you
    if (process.env.YOUR_NOTIFY_EMAIL) {
      await sendEmail({
        to: process.env.YOUR_NOTIFY_EMAIL,
        subject: `Client New Lead: ${client.name} (${client.code})`,
        html: `<p>New lead submitted for <b>${client.name}</b>: ${lead.name} - ${lead.email}</p>`
      });
    }

    // Auto reply to lead with booking link
    if (client.bookingLink) {
      await sendEmail({
        to: lead.email,
        subject: `Thanks — Book Your Call`,
        html: `
          <p>Hi ${lead.name},</p>
          <p>Thanks for reaching out to <b>${client.name}</b>.</p>
          <p>Please book a call here:</p>
          <p><a href="${client.bookingLink}">${client.bookingLink}</a></p>
        `
      });
    }
  }

  // Thank you page shows booking link even without email
  res.render("thanks", { client });
});

// Start
app.listen(PORT, () => console.log(`✅ Running: http://127.0.0.1:${PORT}`));

require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "orbit-secret-key",
    resave: false,
    saveUninitialized: false
  })
);

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect("/login");
  next();
}

// ---------------- HELPERS ----------------
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}
function getBankBlock() {
  return `
Bank Transfer Details:
Account Name: ${process.env.BANK_ACCOUNT_NAME || "-"}
Bank Name: ${process.env.BANK_NAME || "-"}
Account Number: ${process.env.BANK_ACCOUNT_NUMBER || "-"}
Currency: ${process.env.BANK_CURRENCY || "USD"}
Note: ${process.env.BANK_PAYMENT_NOTE || ""}
`;
}
async function sendEmailSafe({ to, subject, text }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || user;

  if (!host || !user || !pass || !to) {
    console.log("📭 Email skipped (SMTP not configured or missing recipient).");
    return { ok: false, skipped: true };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });

    await transporter.sendMail({ from, to, subject, text });
    console.log("✅ Email sent to:", to);
    return { ok: true };
  } catch (err) {
    console.log("❌ Email error:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------- BILLING CHECK ----------------
async function runBillingCheck() {
  const now = new Date();
  const clients = await prisma.client.findMany();

  const remind1 = Number(process.env.REMIND_DAYS_BEFORE || 5);
  const remind2 = Number(process.env.REMIND_DAYS_BEFORE_2 || 1);
  const fee = process.env.MONTHLY_FEE || "2000";

  for (const c of clients) {
    const due = new Date(c.nextDueDate);
    const daysLeft = daysBetween(now, due);

    // Auto-pause if overdue
    if (now > due && !c.isPaused) {
      await prisma.client.update({
        where: { id: c.id },
        data: { isPaused: true, pauseReason: "Payment overdue" }
      });

      const msg = `Your Orbit system is paused because payment is overdue.\n\nAmount: $${fee}/month\n\n${getBankBlock()}`;
      await sendEmailSafe({
        to: c.email,
        subject: "Orbit Account Paused - Payment Overdue",
        text: msg
      });

      if (process.env.YOUR_NOTIFY_EMAIL) {
        await sendEmailSafe({
          to: process.env.YOUR_NOTIFY_EMAIL,
          subject: `[ADMIN] Client Paused: ${c.name}`,
          text: `Client ${c.name} (${c.code}) was auto-paused. Due date: ${due.toISOString().slice(0, 10)}`
        });
      }
      continue;
    }

    // Reminders (max once per day)
    const last = c.lastReminderAt ? new Date(c.lastReminderAt) : null;
    const lastWasToday = last && last.toDateString() === now.toDateString();

    if (!lastWasToday && (daysLeft === remind1 || daysLeft === remind2)) {
      const msg =
        `Payment Reminder: Your Orbit subscription for ${c.name} is due in ${daysLeft} day(s).\n\n` +
        `Amount: $${fee}/month\n\n` +
        `${getBankBlock()}\n\n` +
        `After paying, reply with proof of payment to activate/keep your system running.`;

      await sendEmailSafe({
        to: c.email,
        subject: `Payment Reminder - ${daysLeft} day(s) left`,
        text: msg
      });

      if (process.env.YOUR_NOTIFY_EMAIL) {
        await sendEmailSafe({
          to: process.env.YOUR_NOTIFY_EMAIL,
          subject: `[ADMIN] Reminder Sent: ${c.name}`,
          text: `Reminder sent to ${c.email} | Days left: ${daysLeft}`
        });
      }

      await prisma.client.update({
        where: { id: c.id },
        data: { lastReminderAt: now }
      });
    }
  }
}

// Daily billing check at 09:00
cron.schedule("0 9 * * *", async () => {
  console.log("⏰ Daily billing check running...");
  await runBillingCheck();
});

// ---------------- ROUTES ----------------
app.get("/__health", (req, res) => res.send("OK"));
app.get("/", (req, res) =>
  res.send("Orbit MVP PRO ✅ | /login | /admin | /intake | /c/CLIENTCODE")
);

// LOGIN (username + password)
app.get("/login", (req, res) => res.render("login"));

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.admin = true;
    return res.redirect("/admin");
  }

  return res.status(401).send("Wrong login details");
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

// Intake (keep simple: if your intake views exist, it works)
app.get("/intake", (req, res) => res.render("intake"));
app.post("/intake", async (req, res) => {
  const { businessName, contactName, email, phone, bookingUrl, notes } = req.body;

  await prisma.clientIntake.create({
    data: {
      businessName,
      contactName,
      email,
      phone: phone || null,
      bookingUrl: bookingUrl || null,
      notes: notes || null
    }
  });

  res.render("intake_success");
});

// Admin dashboard (requires your dashboard.ejs)
app.get("/admin", requireAdmin, async (req, res) => {
  const clients = await prisma.client.findMany({ orderBy: { createdAt: "desc" } });
  const leads = await prisma.lead.findMany({
    include: { client: true },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  const intakes = await prisma.clientIntake.findMany({
    where: { status: "new" },
    orderBy: { createdAt: "desc" }
  });

  const now = new Date();
  const clientsWithDays = clients.map(c => ({
    ...c,
    daysLeft: daysBetween(now, new Date(c.nextDueDate))
  }));

  res.render("admin/dashboard", { clients: clientsWithDays, leads, intakes });
});

app.post("/admin/run-billing", requireAdmin, async (req, res) => {
  await runBillingCheck();
  res.redirect("/admin");
});

app.post("/admin/clients/create", requireAdmin, async (req, res) => {
  const { name, code, email, bookingUrl } = req.body;
  const start = new Date();
  const due = addDays(start, 30);

  await prisma.client.create({
    data: {
      name,
      code,
      email,
      bookingUrl: bookingUrl || null,
      subscriptionStart: start,
      nextDueDate: due,
      isPaused: false,
      pauseReason: null
    }
  });

  res.redirect("/admin");
});

app.post("/admin/intakes/:id/approve", requireAdmin, async (req, res) => {
  const intake = await prisma.clientIntake.findUnique({ where: { id: req.params.id } });
  if (!intake) return res.status(404).send("Intake not found");

  let baseCode = (intake.businessName || "client")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);

  if (!baseCode) baseCode = "client";
  let code = baseCode;
  let n = 1;
  while (await prisma.client.findUnique({ where: { code } })) {
    n += 1;
    code = `${baseCode}${n}`;
  }

  const start = new Date();
  const due = addDays(start, 30);

  await prisma.client.create({
    data: {
      name: intake.businessName,
      code,
      email: intake.email,
      bookingUrl: intake.bookingUrl || null,
      subscriptionStart: start,
      nextDueDate: due,
      isPaused: false,
      pauseReason: null
    }
  });

  await prisma.clientIntake.update({
    where: { id: intake.id },
    data: { status: "approved" }
  });

  res.redirect("/admin");
});

app.post("/admin/clients/:id/toggle", requireAdmin, async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send("Client not found");

  await prisma.client.update({
    where: { id: c.id },
    data: {
      isPaused: !c.isPaused,
      pauseReason: !c.isPaused ? "Paused by admin" : null
    }
  });

  res.redirect("/admin");
});

app.post("/admin/clients/:id/paid", requireAdmin, async (req, res) => {
  const start = new Date();
  const due = addDays(start, 30);

  await prisma.client.update({
    where: { id: req.params.id },
    data: {
      isPaused: false,
      pauseReason: null,
      subscriptionStart: start,
      nextDueDate: due,
      lastReminderAt: null
    }
  });

  res.redirect("/admin");
});

app.post("/admin/clients/:id/booking", requireAdmin, async (req, res) => {
  const { bookingUrl } = req.body;
  await prisma.client.update({
    where: { id: req.params.id },
    data: { bookingUrl: bookingUrl || null }
  });
  res.redirect("/admin");
});

app.get("/c/:code", async (req, res) => {
  const client = await prisma.client.findUnique({ where: { code: req.params.code } });
  if (!client) return res.status(404).send("Client not found");
  if (client.isPaused) return res.status(403).send("This client is paused. Please contact support.");
  res.render("landing", { client });
});

app.post("/lead", async (req, res) => {
  const { clientCode, name, email, phone, message } = req.body;
  const client = await prisma.client.findUnique({ where: { code: clientCode } });
  if (!client) return res.status(400).send("Invalid client");

  await prisma.lead.create({
    data: {
      clientId: client.id,
      name,
      email,
      phone: phone || null,
      message: message || null
    }
  });

  res.render("thanks", { client });
});

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).send("Server error. Check VS Code terminal for details.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Running: http://127.0.0.1:${port}`));
